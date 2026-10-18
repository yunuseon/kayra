import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { all, err, ok, type Result } from "../result.ts";
import { field, registered, type App } from "./app.ts";
import { appName, appOwner, jobOwner, newRunId, sha, type JobName, type Owner, type RunId, type Sha } from "./brand.ts";
import { matches, parseCron, type Cron } from "./cron.ts";
import { statusRequest } from "./forge.ts";
import { json, send } from "./http.ts";
import { spawnLines } from "./process.ts";
import { empty, enqueue, finish, type Queue, type Request, type Why } from "./queue.ts";
import { expired, moved, releaseName, releases, type RunMeta } from "./records.ts";
import { githubIssues } from "./github-issues.ts";
import { decide, parseNotify, silent, type Notifier, type NotifyConfig, type RunEnd } from "./notify.ts";
import { deploy, renovate, type Effects, type Env, type Outcome } from "./run.ts";
import { runsOf } from "./store.ts";

/**
 * The deployer: the half that holds the docker socket and the app secrets.
 * Never routed by Traefik. It queues runs, asks the builder for bundles,
 * admits and starts them, records releases, posts commit statuses, and runs
 * the platform's scheduled jobs (registry GC, Renovate, the hourly poll).
 *
 *   :8090  platform-internal: POST /push/<app> (the builder, after a webhook)
 *   :8091  inside the container only: POST /deploy, POST /job (kayra app …, kayra job …)
 */
type Settings = {
  readonly platformDir: string;
  readonly appsDir: string;
  readonly builder: string;
  readonly domain: string;
  readonly policyScript: string;
  readonly gcScript: string;
  readonly renovateImage: string;
  readonly renovate: Cron | undefined;
  readonly gc: Cron;
  readonly poll: Cron;
  readonly env: Env;
  /** The server's name in the fleet, for alerts that may come from several. */
  readonly server: string;
  readonly notifier: Notifier;
};

const token = (name: string): string => {
  const path = `/run/platform-secrets/${name}`;
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
};

const must = <T>(result: Result<T, string>): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const settings = (env: NodeJS.ProcessEnv): Settings => {
  const scripts = env["PLATFORM_SCRIPTS"] ?? "/opt/kayra/scripts/platform";
  const strings = Object.fromEntries(Object.entries(env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])));
  return {
    platformDir: env["PLATFORM_DIR"] ?? "/opt/platform",
    appsDir: env["APPS_DIR"] ?? "/opt/apps",
    builder: env["BUILDER_URL"] ?? "http://builder:8081",
    domain: env["DOMAIN"] ?? "localhost",
    policyScript: join(scripts, "compose-policy.sh"),
    gcScript: join(scripts, "registry-gc.sh"),
    renovateImage: env["RENOVATE_IMAGE"] ?? "",
    renovate: env["PLATFORM_RENOVATE"] === "true" ? must(parseCron(env["RENOVATE_SCHEDULE"] ?? "0 4 * * 1")) : undefined,
    gc: must(parseCron("0 3 * * *")),
    poll: must(parseCron("17 * * * *")),
    env: strings,
    server: env["SERVER"] ?? env["DOMAIN"] ?? "this server",
    notifier: notifierFor(must(parseNotify(env["NOTIFIER"])), env["PLATFORM_DIR"] ?? "/opt/platform"),
  };
};

/** The configured notifier; its open alerts are kept in <platformDir>/alerts/<key>. */
const notifierFor = (config: NotifyConfig, platformDir: string): Notifier => {
  if (config.kind === "none") return silent;
  const alerts = join(platformDir, "alerts");
  const keyFile = "/run/deployer-secrets/NOTIFIER_GITHUB_APP_KEY";
  return githubIssues(config.repository, config.appId, {
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      return { status: response.status, json: await response.json().catch(() => undefined) };
    },
    privateKey: () => (existsSync(keyFile) ? ok(readFileSync(keyFile, "utf8")) : err(`${keyFile} is missing: notifier_github_app_key in secrets.yml`)),
    now: () => Date.now(),
    openIssue: (key) => {
      const path = join(alerts, key);
      const number = existsSync(path) ? Number(readFileSync(path, "utf8")) : Number.NaN;
      return Number.isInteger(number) ? number : undefined;
    },
    remember: (key, issue) => {
      mkdirSync(alerts, { recursive: true });
      if (issue === undefined) rmSync(join(alerts, key), { force: true });
      else writeFileSync(join(alerts, key), String(issue));
    },
  });
};

/** Raises or resolves what the finished run means; a notifier's failure is logged, never the run's. */
const notify = async (s: Settings, end: RunEnd, log: (line: string) => void): Promise<void> => {
  const decision = decide(end);
  const done =
    decision.kind === "raise"
      ? await s.notifier.raise(decision.alert)
      : decision.kind === "resolve"
        ? await s.notifier.resolve(decision.key, decision.note)
        : ok(undefined);
  if (!done.ok) log(`(alert not sent: ${done.error})`);
};

const runsDir = (s: Settings): string => join(s.platformDir, "runs");
const keepRuns = 50;

const registeredApps = (s: Settings): readonly App[] => {
  const dir = join(s.platformDir, "apps");
  return (existsSync(dir) ? readdirSync(dir) : []).flatMap((file) => {
    const name = /^(.+)\.json$/.exec(file)?.[1];
    const app = name === undefined ? undefined : registered(s.platformDir, name);
    return app?.ok === true ? [app.value] : [];
  });
};

const builderResolve = async (s: Settings, app: App, ref: string): Promise<Result<Sha, string>> => {
  const response = await fetch(`${s.builder}/resolve`, { method: "POST", body: JSON.stringify({ app: app.name, ref }) }).catch(() => undefined);
  if (response === undefined) return err("the builder did not answer");
  const answer: unknown = await response.json().catch(() => undefined);
  const given = typeof answer === "object" && answer !== null ? field(answer, "sha") : undefined;
  const problem = typeof answer === "object" && answer !== null ? field(answer, "error") : undefined;
  return typeof given === "string" ? sha(given) : err(typeof problem === "string" ? problem : `resolve: HTTP ${String(response.status)}`);
};

/** The builder's NDJSON: log lines as they come, then the bundle or an error. */
const builderPrepare = async (s: Settings, app: App, commit: Sha, log: (line: string) => void): Promise<Result<unknown, string>> => {
  const response = await fetch(`${s.builder}/prepare`, {
    method: "POST",
    body: JSON.stringify({ app: app.name, sha: commit }),
    signal: AbortSignal.timeout(45 * 60_000),
  }).catch(() => undefined);
  if (response?.body == null || !response.ok) return err("the builder did not prepare a bundle");
  const lines = createInterface({ input: Readable.fromWeb(response.body) });
  const outcome = await Array.fromAsync(lines, (line: string) => {
    try {
      const message: unknown = JSON.parse(line);
      if (typeof message !== "object" || message === null) return undefined;
      const text = field(message, "log");
      if (typeof text === "string") log(text);
      const bundle = field(message, "bundle");
      const problem = field(message, "error");
      return bundle !== undefined ? ok(bundle) : typeof problem === "string" ? err(problem) : undefined;
    } catch {
      return undefined;
    }
  });
  return outcome.findLast((item) => item !== undefined) ?? err("the builder stopped without a bundle");
};

const appSecrets = (app: App): Result<Env, string> => {
  const read = all(
    app.secrets.map((key): Result<readonly [string, string], string> => {
      const path = join("/run/app-secrets", app.name, key);
      return existsSync(path) ? ok([key, readFileSync(path, "utf8")]) : err(`${app.name}: secret ${key} is missing; run kayra apps`);
    }),
  );
  return read.ok ? ok(Object.fromEntries(read.value)) : read;
};

const target = (s: Settings, who: Owner, id: RunId): string => `https://deploy.${s.domain}/runs/${who}/${id}`;

const effects = (s: Settings, who: Owner, id: RunId, log: (line: string) => void): Effects => ({
  log,
  resolve: (app, ref) => builderResolve(s, app, ref),
  prepare: (app, commit) => builderPrepare(s, app, commit, log),
  exec: (argv, options) => spawnLines(argv, { ...options, timeoutMs: 20 * 60_000 }, log),
  secrets: appSecrets,
  workdir: (bundle, images) => {
    const dir = mkdtempSync(join(tmpdir(), `${id}-`));
    writeFileSync(join(dir, "images.env"), images);
    bundle.compose.forEach((file) => {
      mkdirSync(dirname(join(dir, file.path)), { recursive: true });
      writeFileSync(join(dir, file.path), file.content);
    });
    return Promise.resolve(dir);
  },
  record: (app, commit, images) => {
    const dir = join(s.platformDir, "releases", app.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, releaseName(new Date(), commit)), images);
    return Promise.resolve();
  },
  status: async (app, commit, context, state, description) => {
    const request = statusRequest(app.repo, commit, { context, state, description, target: target(s, who, id) }, token("GIT_TOKEN"));
    if (request === undefined) {
      log(`(no commit status: ${app.repo} is on no forge kayra knows)`);
      return;
    }
    const response = await fetch(request.url, { method: "POST", headers: request.headers, body: request.body }).catch(() => undefined);
    if (response?.ok !== true) log(`(commit status ${context} not posted: ${response === undefined ? "no answer" : `HTTP ${String(response.status)}`})`);
  },
});

const describe = (request: Request): { readonly what: string; readonly why: RunMeta["why"] } =>
  request.work.kind === "deploy"
    ? { what: `deploy ${request.work.ref}`, why: request.work.why }
    : { what: `${request.work.job}${request.work.dryRun ? " (dry run)" : ""}`, why: "schedule" };

const work = async (s: Settings, request: Request, fx: Effects): Promise<Outcome> => {
  if (request.work.kind === "deploy") {
    const app = registered(s.platformDir, request.work.app);
    if (!app.ok) {
      fx.log(app.error);
      return { ok: false };
    }
    return deploy(app.value, request.work.ref, { appsDir: s.appsDir, policyScript: s.policyScript }, fx);
  }
  const argv = request.work.job === "gc" ? (["bash", s.gcScript] as const) : renovate(s.env, request.work.dryRun, s.renovateImage);
  const env: Env = request.work.job === "renovate" ? { RENOVATE_TOKEN: token("RENOVATE_TOKEN") } : {};
  const exit = await fx.exec(argv, { cwd: s.platformDir, env });
  return { ok: exit.code === 0 };
};

/** The daemon's one mutable cell: the queue, swapped whole on every change. */
// eslint-disable-next-line functional/prefer-immutable-types -- the daemon's state lives here, nowhere else
const cell: { queue: Queue } = { queue: empty(2) };

/** Applies a change to the queue and starts what it lets start; returns those. */
const swap = (s: Settings, change: (queue: Queue) => { readonly queue: Queue; readonly start: readonly Request[] }): readonly Request[] => {
  const next = change(cell.queue);
  // eslint-disable-next-line functional/immutable-data -- the daemon's state lives here, nowhere else
  cell.queue = next.queue;
  next.start.forEach((request) => {
    void start(s, request);
  });
  return next.start;
};

const start = async (s: Settings, request: Request): Promise<void> => {
  const id = newRunId(new Date(), randomBytes(3).toString("hex"));
  const dir = join(runsDir(s), request.owner, id);
  mkdirSync(dir, { recursive: true });
  const { what, why } = describe(request);
  const begun: RunMeta = { id, owner: request.owner, what, why, state: "running", started: new Date().toISOString() };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(begun));
  const log = (line: string): void => {
    appendFileSync(join(dir, "log"), `${new Date().toISOString().slice(11, 19)} ${line}\n`);
  };
  const outcome = await work(s, request, effects(s, request.owner, id, log)).catch((error: unknown): Outcome => {
    log(`deployer: ${String(error)}`);
    return { ok: false };
  });
  const ended: RunMeta = {
    ...begun,
    ...(outcome.sha === undefined ? {} : { sha: outcome.sha }),
    state: outcome.ok ? "success" : "failure",
    finished: new Date().toISOString(),
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(ended));
  await notify(
    s,
    { server: s.server, request, ok: outcome.ok, ...(outcome.sha === undefined ? {} : { sha: outcome.sha }), page: target(s, request.owner, id) },
    log,
  );
  expired(readdirSync(join(runsDir(s), request.owner)), keepRuns).forEach((old) => {
    rmSync(join(runsDir(s), request.owner, old), { recursive: true, force: true });
  });
  readdirSync(tmpdir())
    .filter((name) => name.startsWith(`${id}-`))
    .forEach((name) => {
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    });
  swap(s, (queue) => finish(queue, request.owner));
};

const deployRequest = (app: App, ref: string, why: Why): Request => ({
  owner: appOwner(app.name),
  work: { kind: "deploy", app: app.name, ref, why },
});

const jobRequest = (job: JobName, dryRun: boolean): Request => ({ owner: jobOwner(job), work: { kind: "job", job, dryRun } });

/** The webhook's fallback: an app whose ref moved to a commit no run has tried yet and no release runs (one migrated from Jenkins has releases but no runs). */
const poll = async (s: Settings): Promise<void> => {
  await Promise.all(
    registeredApps(s).map(async (app) => {
      const commit = await builderResolve(s, app, app.ref);
      const lastRun = runsOf(runsDir(s), appOwner(app.name)).find((run) => run.sha !== undefined);
      const releasesDir = join(s.platformDir, "releases", app.name);
      const lastRelease = releases(existsSync(releasesDir) ? readdirSync(releasesDir) : [])[0];
      if (commit.ok && moved(commit.value, lastRun?.sha, lastRelease?.sha)) swap(s, (queue) => enqueue(queue, deployRequest(app, app.ref, "poll")));
    }),
  );
};

const tick = (s: Settings, at: Date): void => {
  if (matches(s.poll, at)) void poll(s);
  if (matches(s.gc, at)) swap(s, (queue) => enqueue(queue, jobRequest("gc", false)));
  if (s.renovate !== undefined && matches(s.renovate, at)) swap(s, (queue) => enqueue(queue, jobRequest("renovate", false)));
};

const schedule = (s: Settings): void => {
  const wait = 60_000 - (Date.now() % 60_000) + 500;
  setTimeout(() => {
    tick(s, new Date());
    schedule(s);
  }, wait);
};

const handle =
  (handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) =>
  (request: IncomingMessage, response: ServerResponse): void => {
    handler(request, response).catch((error: unknown) => {
      console.error(error);
      if (!response.headersSent) send(response, 500, "internal error\n");
    });
  };

const accept = (s: Settings, response: ServerResponse, request: Request): void => {
  const started = swap(s, (queue) => enqueue(queue, request)).includes(request);
  send(response, 202, started ? `${request.owner}: started\n` : `${request.owner}: queued, after what runs now\n`);
};

const control = async (s: Settings, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const path = new URL(request.url ?? "/", "http://deployer").pathname;
  const input = await json(request);
  if (request.method !== "POST" || typeof input !== "object" || input === null) {
    send(response, 400, "bad request\n");
    return;
  }
  if (path === "/deploy") {
    const name = field(input, "app");
    const ref = field(input, "ref");
    const why = field(input, "why") === "rollback" ? "rollback" : "deploy";
    const app = registered(s.platformDir, typeof name === "string" ? name : "");
    if (!app.ok) {
      send(response, 404, `${app.error}\n`);
      return;
    }
    accept(s, response, deployRequest(app.value, typeof ref === "string" && ref !== "" ? ref : app.value.ref, why));
    return;
  }
  const job = field(input, "job");
  if (path === "/job" && (job === "gc" || job === "renovate")) {
    if (job === "renovate" && s.renovate === undefined) {
      send(response, 409, "this server has no renovate_repositories\n");
      return;
    }
    accept(s, response, jobRequest(job, field(input, "dryRun") === true));
    return;
  }
  send(response, 404, "not found\n");
};

export const serveDeployer = (env: NodeJS.ProcessEnv): void => {
  const s = settings(env);
  createServer(
    handle(async (request, response) => {
      const name = /^\/push\/([^/]+)$/.exec(new URL(request.url ?? "/", "http://deployer").pathname)?.[1];
      const app = name === undefined || !appName(name).ok ? undefined : registered(s.platformDir, name);
      if (request.method !== "POST" || app === undefined) {
        send(response, 404, "not found\n");
        return;
      }
      if (!app.ok) {
        send(response, 404, `${app.error}\n`);
        return;
      }
      accept(s, response, deployRequest(app.value, app.value.ref, "push"));
      return Promise.resolve();
    }),
  ).listen(8090);
  createServer(handle((request, response) => control(s, request, response))).listen(8091, "127.0.0.1");
  schedule(s);
  console.log(`deployer: :8090 pushes, 127.0.0.1:8091 control; renovate ${s.renovate === undefined ? "off" : "on"}`);
};
