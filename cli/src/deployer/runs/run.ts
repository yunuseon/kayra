import { err, ok, type Result } from "../../lib/result.ts";
import type { App } from "../app.ts";
import type { Sha } from "../brand.ts";
import { imagesEnv, parseBundle, type Bundle } from "../build/bundle.ts";
import { config, policy, up, type Argv } from "../build/compose.ts";
import { describeRoutes, readinessUrl, routesOverride, type Route } from "../build/routes.ts";
import type { Check } from "./records.ts";
import type { Context, State } from "../forges/forge.ts";
import { typed } from "../../lib/typed.ts";

export type Env = Readonly<Record<string, string>>;
export type Exit = { readonly code: number; readonly stdout: string };

/** Everything a run does to the world, so the run itself can be tested with fakes. */
export type Effects = {
  readonly log: (line: string) => void;
  /** A branch, tag or full commit id to the commit it names, asked of the builder. */
  readonly resolve: (app: App, ref: string) => Promise<Result<Sha, string>>;
  /** The builder's bundle for that commit, unchecked; its log lines go to `log`. */
  readonly prepare: (app: App, commit: Sha) => Promise<Result<unknown, string>>;
  /** stdout captured only with `capture`; everything else reaches the log. */
  readonly exec: (argv: Argv, options: { readonly cwd: string; readonly env: Env; readonly stdin?: string; readonly capture?: boolean }) => Promise<Exit>;
  readonly secrets: (app: App) => Result<Env, string>;
  /** A fresh directory holding the bundle's compose files and images.env (compose.ts says where). */
  readonly workdir: (bundle: Bundle, images: string) => Promise<string>;
  /** The platform's routes file, written into that directory once the app's files are admitted. */
  readonly writeRoutes: (cwd: string, content: string) => Promise<void>;
  readonly record: (app: App, commit: Sha, images: string) => Promise<void>;
  readonly status: (app: App, commit: Sha, context: Context, state: State, description: string) => Promise<void>;
  /** The HTTP status a GET of the URL gets through Traefik, redirects not followed; 0 if nothing answered. */
  readonly probe: (url: string) => Promise<number>;
  readonly pause: (ms: number) => Promise<void>;
};

/** Where a run deploys: the apps' directory, the policy that admits them, the server's domain. */
export type Site = { readonly appsDir: string; readonly policyScript: string; readonly domain: string };

export type Outcome = {
  readonly ok: boolean;
  readonly sha?: Sha;
  readonly error?: string;
  readonly urls?: readonly string[];
  readonly checks?: readonly Check[];
};

/** How often, and how far apart, a URL is asked before it counts as not ready: a minute. */
const tries = 30;
const apart = 2_000;
/** Traefik answers 404 until it has seen the new containers; without a check path, a 404 counts only after this many tries. */
const routerGrace = 5;

/**
 * Whether a URL is ready. With a check path: 2xx or 3xx. Without one, the
 * app owes no particular answer, only one below 500.
 */
const passes = (status: number, strict: boolean, attempt: number) =>
  strict ? status >= 200 && status < 400 : status > 0 && status < 500 && (status !== 404 || attempt >= routerGrace);

const probeUntil = async (fx: Effects, url: string, strict: boolean, attempt = 1): Promise<Check> => {
  const status = await fx.probe(url);
  if (passes(status, strict, attempt)) return { url, status, ok: true };
  if (attempt >= tries) return { url, status, ok: false };
  await fx.pause(apart);
  return probeUntil(fx, url, strict, attempt + 1);
};

/** Each route asked through Traefik, once per URL; a URL some route gave a check path for is held to it. */
const readiness = async (routes: readonly Route[], domain: string, fx: Effects) => {
  const urls = [...new Set(routes.map((route) => readinessUrl(route, domain)))];
  const strict = (url: string) => routes.some((route) => route.check !== undefined && readinessUrl(route, domain) === url);
  if (urls.length > 0) fx.log(`── Ready? ${urls.join(", ")}`);
  const checks = await Promise.all(urls.map((url) => probeUntil(fx, url, strict(url))));
  checks.forEach((check) => {
    fx.log(`${check.ok ? "ready" : "NOT READY"}  ${check.url}  ${check.status === 0 ? "no answer" : String(check.status)}`);
  });
  return Object.freeze(checks);
};

/** Where the app answers: each routed host once. */
const appUrls = (routes: readonly Route[], domain: string) =>
  Object.freeze([...new Set(routes.map((route) => `https://${route.host}.${domain}/`))]);

const notReady = (checks: readonly Check[]) =>
  checks
    .filter((check) => !check.ok)
    .map((check) => `${check.url} ${check.status === 0 ? "did not answer" : `answered ${String(check.status)}`}`)
    .join("; ");

const step = async (fx: Effects, label: string, argv: Argv, options: Parameters<Effects["exec"]>[1]) => {
  fx.log(`── ${label}`);
  const exit = await fx.exec(argv, options);
  return exit.code === 0 ? ok<string>(exit.stdout) : err(`${label} failed (exit ${String(exit.code)})`);
};

/**
 * Admission, then up: the compose config of the commit being deployed must
 * pass the policy before anything starts, and what it checked is what runs,
 * with the routes the platform writes from it.
 */
const deployBundle = async (app: App, bundle: Bundle, site: Site, fx: Effects) => {
  const images = imagesEnv(bundle);
  const secrets = fx.secrets(app);
  if (!secrets.ok) return secrets;
  const cwd = await fx.workdir(bundle, images);
  const resolved = await step(fx, "Admission: compose config", config(app, site.appsDir, bundle), { cwd, env: secrets.value, capture: true });
  if (!resolved.ok) return resolved;
  const admitted = await step(fx, "Admission: policy", policy(app, site.policyScript, site.domain, bundle), { cwd, env: {}, stdin: resolved.value });
  if (!admitted.ok) return err("refused by the compose policy");
  const routes = routesOverride(app.name, site.domain, bundle.routes, resolved.value);
  if (!routes.ok) return routes;
  fx.log(`── Routes: ${describeRoutes(bundle.routes)}`);
  await fx.writeRoutes(cwd, routes.value);
  const started = await step(fx, "Up", up(app, site.appsDir, bundle), { cwd, env: secrets.value });
  if (!started.ok) return started;
  await fx.record(app, bundle.sha, images);
  return ok<string>(images);
};

/**
 * One deploy: the ref to a commit, its images built where missing (kayra/build),
 * then admitted and started (kayra/deploy). Each phase posts its status on the
 * commit; a failed build never reaches deploy.
 */
export const deploy = async (app: App, ref: string, site: Site, fx: Effects) => {
  fx.log(`Deploying ${app.name} at ${ref}`);
  const commit = await fx.resolve(app, ref);
  if (!commit.ok) {
    fx.log(commit.error);
    return typed<Outcome>({ ok: false, error: commit.error });
  }
  const sha = commit.value;
  fx.log(`── ${ref} is ${sha}`);

  await fx.status(app, sha, "kayra/build", "pending", "Building images");
  const raw = await fx.prepare(app, sha);
  const bundle = raw.ok ? parseBundle(app.name, sha, raw.value) : raw;
  if (!bundle.ok) {
    fx.log(bundle.error);
    await fx.status(app, sha, "kayra/build", "failure", "Build failed");
    return typed<Outcome>({ ok: false, sha, error: `build: ${bundle.error}` });
  }
  await fx.status(app, sha, "kayra/build", "success", "Images built");

  await fx.status(app, sha, "kayra/deploy", "pending", "Deploying");
  const deployed = await deployBundle(app, bundle.value, site, fx);
  if (!deployed.ok) {
    fx.log(deployed.error);
    await fx.status(app, sha, "kayra/deploy", "failure", deployed.error);
    return typed<Outcome>({ ok: false, sha, error: deployed.error });
  }
  const urls = appUrls(bundle.value.routes, site.domain);
  const checks = await readiness(bundle.value.routes, site.domain, fx);
  const unready = notReady(checks);
  if (unready !== "") {
    const error = `running, but not ready: ${unready}`;
    fx.log(error);
    await fx.status(app, sha, "kayra/deploy", "failure", "Not ready");
    return typed<Outcome>({ ok: false, sha, error, urls, checks });
  }
  fx.log(`Deployed ${sha}`);
  await fx.status(app, sha, "kayra/deploy", "success", "Deployed");
  return typed<Outcome>({ ok: true, sha, urls, checks });
};

/** Renovate's settings, as the platform's .env holds them; the optional ones only when set. */
export const renovate = (env: Env, dryRun: boolean, image: string) => {
  const optional = ["RENOVATE_ENDPOINT", "RENOVATE_GIT_URL", "RENOVATE_HOST_RULES", "RENOVATE_GITHUB_COM_TOKEN"]
    .filter((key) => (env[key] ?? "") !== "")
    .flatMap((key) => ["-e", key] as const);
  return typed<Argv>([
    "docker", "run", "--rm", "--network", "platform-internal",
    "-e", "RENOVATE_TOKEN", "-e", "RENOVATE_PLATFORM", ...optional, "-e", "RENOVATE_REPOSITORIES",
    "-e", `RENOVATE_DRY_RUN=${dryRun ? "full" : "null"}`, "-e", "LOG_LEVEL=info",
    image,
  ]);
};
