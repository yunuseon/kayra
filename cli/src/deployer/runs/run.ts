import { err, ok, type Result } from "../../result.ts";
import type { App } from "../app.ts";
import type { Sha } from "../brand.ts";
import { imagesEnv, parseBundle, type Bundle } from "../build/bundle.ts";
import { config, policy, up, type Argv } from "../build/compose.ts";
import type { Context, State } from "../forges/forge.ts";
import { typed } from "../../typed.ts";

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
  /** A fresh directory holding the bundle's compose files and images.env. */
  readonly workdir: (bundle: Bundle, images: string) => Promise<string>;
  readonly record: (app: App, commit: Sha, images: string) => Promise<void>;
  readonly status: (app: App, commit: Sha, context: Context, state: State, description: string) => Promise<void>;
};

export type Paths = { readonly appsDir: string; readonly policyScript: string };

export type Outcome = { readonly ok: boolean; readonly sha?: Sha };

const step = async (fx: Effects, label: string, argv: Argv, options: Parameters<Effects["exec"]>[1]) => {
  fx.log(`── ${label}`);
  const exit = await fx.exec(argv, options);
  return exit.code === 0 ? ok<string>(exit.stdout) : err(`${label} failed (exit ${String(exit.code)})`);
};

/**
 * Admission, then up: the compose config of the commit being deployed must
 * pass the policy before anything starts, and what it checked is what runs.
 */
const deployBundle = async (app: App, bundle: Bundle, paths: Paths, fx: Effects) => {
  const images = imagesEnv(bundle);
  const secrets = fx.secrets(app);
  if (!secrets.ok) return secrets;
  const cwd = await fx.workdir(bundle, images);
  const resolved = await step(fx, "Admission: compose config", config(app, paths.appsDir, bundle), { cwd, env: secrets.value, capture: true });
  if (!resolved.ok) return resolved;
  const admitted = await step(fx, "Admission: policy", policy(app, paths.policyScript), { cwd, env: {}, stdin: resolved.value });
  if (!admitted.ok) return err("refused by the compose policy");
  const started = await step(fx, "Up", up(app, paths.appsDir, bundle), { cwd, env: secrets.value });
  if (!started.ok) return started;
  await fx.record(app, bundle.sha, images);
  return ok<string>(images);
};

/**
 * One deploy: the ref to a commit, its images built where missing (kayra/build),
 * then admitted and started (kayra/deploy). Each phase posts its status on the
 * commit; a failed build never reaches deploy.
 */
export const deploy = async (app: App, ref: string, paths: Paths, fx: Effects) => {
  fx.log(`Deploying ${app.name} at ${ref}`);
  const commit = await fx.resolve(app, ref);
  if (!commit.ok) {
    fx.log(commit.error);
    return typed<Outcome>({ ok: false });
  }
  const sha = commit.value;
  fx.log(`── ${ref} is ${sha}`);

  await fx.status(app, sha, "kayra/build", "pending", "Building images");
  const raw = await fx.prepare(app, sha);
  const bundle = raw.ok ? parseBundle(app.name, sha, raw.value) : raw;
  if (!bundle.ok) {
    fx.log(bundle.error);
    await fx.status(app, sha, "kayra/build", "failure", "Build failed");
    return typed<Outcome>({ ok: false, sha });
  }
  await fx.status(app, sha, "kayra/build", "success", "Images built");

  await fx.status(app, sha, "kayra/deploy", "pending", "Deploying");
  const deployed = await deployBundle(app, bundle.value, paths, fx);
  if (!deployed.ok) {
    fx.log(deployed.error);
    await fx.status(app, sha, "kayra/deploy", "failure", deployed.error);
    return typed<Outcome>({ ok: false, sha });
  }
  fx.log(`Deployed ${sha}`);
  await fx.status(app, sha, "kayra/deploy", "success", "Deployed");
  return typed<Outcome>({ ok: true, sha });
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
