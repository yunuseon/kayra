import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { field, registered, registrations, type App } from "./app.ts";
import { appName, appOwner, newRunId } from "./brand.ts";
import { builderResolve } from "./build/client.ts";
import { json, send } from "./http/http.ts";
import { describe, empty, enqueue, finish, jobRequest, type Queue, type Request, type Why } from "./runs/queue.ts";
import { ended, moved, type RunMeta } from "./runs/records.ts";
import { legacyReleases } from "./runs/release-read.ts";
import { deliver } from "../server/platform/notify.ts";
import { schedule } from "../server/platform/schedule.ts";
import { runMaintenance, type MaintenanceEffects } from "../server/platform/maintenance.ts";
import { commandExecution, effects, runPage } from "./runs/effects.ts";
import { deploy, type Effects, type Outcome } from "./runs/run.ts";
import { toRestore, type Deployed } from "../server/deployment/legacy-restore.ts";
import { spawnLines } from "./process.ts";
import { appendLog, meta, owners, prune, runsOf, writeMeta } from "./runs/store.ts";
import { runsDir, settings, token, type Settings } from "./settings.ts";
import { typed } from "../lib/typed.ts";
import { assess, gather } from "./health.ts";
import { startWithLifecycle } from "../server/deployment/startup.ts";
import { composeProjectRunning } from "../server/runtime/compose.ts";

/**
 * The deployer: the half that holds the docker socket and the app secrets.
 * Never routed by Traefik. It queues runs, asks the builder for bundles,
 * admits and starts them, records releases, posts commit statuses, and runs
 * the platform's scheduled jobs (registry GC, Renovate, the hourly poll).
 *
 *   :8090  platform-internal: POST /push/<app> (the builder, after a webhook),
 *          GET /health (the builder, for deploy.<domain>/health)
 *   :8091  inside the container only: POST /deploy, POST /job (kayra app …, kayra job …)
 */

const keepRuns = 50;

const registeredApps = (s: Settings) => registrations(s.platformDir).apps;

const work = async (s: Settings, request: Request, fx: Effects, exec: MaintenanceEffects["exec"]) => {
  if (request.work.kind === "deploy") {
    const app = registered(s.platformDir, request.work.app);
    if (!app.ok) {
      fx.log(app.error);
      return typed<Outcome>({ ok: false });
    }
    return deploy(app.value, request.work.ref, { appsDir: s.appsDir, policyScript: s.policyScript, domain: s.domain }, fx);
  }
  return typed<Outcome>(await runMaintenance(request.work, s, { token, exec }));
};

/** The daemon's one mutable cell: the queue, swapped whole on every change. */
// eslint-disable-next-line functional/prefer-immutable-types -- the daemon's state lives here, nowhere else
const cell: { queue: Queue } = { queue: empty(2) };

type Change = { readonly queue: Queue; readonly start: readonly Request[]; readonly replaced?: readonly Request[] };

const asked = (request: Request, state: RunMeta["state"]) =>
  typed<RunMeta>({ id: request.id, owner: request.owner, ...describe(request), state, started: new Date().toISOString() });

/** Applies a change to the queue, starts what it lets start, and ends what it replaced; returns what started. */
const swap = (s: Settings, change: (queue: Queue) => Change) => {
  const next = change(cell.queue);
  // eslint-disable-next-line functional/immutable-data -- the daemon's state lives here, nowhere else
  cell.queue = next.queue;
  (next.replaced ?? []).forEach((request) => {
    const was = meta(runsDir(s), request.owner, request.id);
    writeMeta(runsDir(s), request.owner, { ...(was ?? asked(request, "superseded")), state: "superseded", finished: new Date().toISOString() });
  });
  next.start.forEach((request) => {
    void start(s, request);
  });
  return next.start;
};

/** A request on record as queued before the queue sees it, so whoever asked can follow it by its id at once. */
const ask = (s: Settings, request: Request) => {
  writeMeta(runsDir(s), request.owner, asked(request, "queued"));
  return swap(s, (queue) => enqueue(queue, request)).includes(request);
};

const newId = () => newRunId(new Date(), randomBytes(3).toString("hex"));

/** Runs a restart cut short: they never end otherwise, and whoever follows one would wait forever. */
const abandon = (s: Settings) => {
  const runs = runsDir(s);
  owners(runs).forEach((who) => {
    runsOf(runs, who)
      .filter((run) => !ended(run.state))
      .forEach((run) => {
        writeMeta(runs, who, { ...run, state: "failure", error: "the deployer restarted before this run ended", finished: new Date().toISOString() });
      });
  });
};

const start = async (s: Settings, request: Request) => {
  const id = request.id;
  const runs = runsDir(s);
  const begun = asked(request, "running");
  writeMeta(runs, request.owner, begun);
  const log = (line: string) => {
    appendLog(runs, request.owner, id, line);
  };
  const scratch = mkdtempSync(join(tmpdir(), `${id}-`));
  const outcome = await work(s, request, effects(s, request.owner, id, scratch, log), commandExecution(log)).catch((error: unknown) => {
    log(`deployer: ${String(error)}`);
    return typed<Outcome>({ ok: false, error: "the deployer failed; see the log" });
  });
  writeMeta(runs, request.owner, {
    ...begun,
    ...(outcome.sha === undefined ? {} : { sha: outcome.sha }),
    state: outcome.ok ? "success" : "failure",
    finished: new Date().toISOString(),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    ...(outcome.urls === undefined ? {} : { urls: outcome.urls }),
    ...(outcome.checks === undefined ? {} : { checks: outcome.checks }),
  });
  await deliver(
    s.notifier,
    { server: s.server, request, ok: outcome.ok, ...(outcome.sha === undefined ? {} : { sha: outcome.sha }), page: runPage(s, request.owner, id) },
    log,
  );
  prune(runs, request.owner, keepRuns);
  rmSync(scratch, { recursive: true, force: true });
  swap(s, (queue) => finish(queue, request.owner));
};

const deployRequest = (app: App, ref: string, why: Why) => typed<Request>({
  id: newId(),
  owner: appOwner(app.name),
  work: { kind: "deploy", app: app.name, ref, why },
});

/** The webhook's fallback: an app whose ref moved to a commit no run has tried yet and no release runs (runs are pruned, releases are not). */
const poll = async (s: Settings) => {
  await Promise.all(
    registeredApps(s).map(async (app) => {
      const commit = await builderResolve(s.builder, app, app.ref);
      const tried = runsOf(runsDir(s), appOwner(app.name)).flatMap((run) => Object.freeze(run.sha === undefined ? [] : [run.sha]));
      const lastRelease = legacyReleases(s.platformDir, app.name).releases[0];
      if (commit.ok && moved(commit.value, tried, lastRelease?.sha)) ask(s, deployRequest(app, app.ref, "poll"));
    }),
  );
};

/**
 * After the deployer starts (and Docker with it): each app that was deployed
 * and runs no container now, deployed again at the release that ran. A Docker
 * update or a reboot stops every container; an app deployed before the
 * platform gave every service a restart policy would otherwise stay down.
 */
const restore = async (s: Settings) => {
  const apps = registeredApps(s);
  const states = await Promise.all(apps.map(async (app) => [app.name, await composeProjectRunning(app, (argv, options) => spawnLines(argv, options, () => undefined))] as const));
  const up = new Map(states);
  toRestore(
    apps.map((app) => {
      return typed<Deployed>({ app: app.name, live: legacyReleases(s.platformDir, app.name).releases[0]?.sha });
    }),
    (app) => up.get(app) ?? true,
  ).forEach(({ app, live }) => {
    const registration = apps.find((each) => each.name === app);
    if (registration !== undefined) ask(s, deployRequest(registration, live, "restore"));
  });
};

/** Long enough for Docker to have started the containers with a restart policy itself. */
const restoreAfter = 30_000;

const handle =
  (handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void) =>
  (request: IncomingMessage, response: ServerResponse) => {
    Promise.resolve(handler(request, response)).catch((error: unknown) => {
      console.error(error);
      if (!response.headersSent) send(response, 500, "internal error\n");
    });
  };

const accept = (s: Settings, response: ServerResponse, request: Request) => {
  const started = ask(s, request);
  send(response, 202, `${JSON.stringify({ id: request.id, owner: request.owner, state: started ? "running" : "queued" })}\n`);
};

/** POST /push/<app>, from the builder once a webhook proved itself: a deploy of the app's own ref. */
const health = async (s: Settings, response: ServerResponse, gatherFacts: typeof gather) => {
  const scanned = registrations(s.platformDir);
  const apps = scanned.apps.map((app) => {
    return Object.freeze({ name: app.name, released: legacyReleases(s.platformDir, app.name).hasEntries });
  });
  const assessed = assess({ ...await gatherFacts(apps, runsDir(s)), invalidRegistrations: scanned.invalid });
  send(response, assessed.healthy ? 200 : 503, JSON.stringify(assessed), "application/json");
};

const push = async (s: Settings, request: IncomingMessage, response: ServerResponse, gatherFacts: typeof gather) => {
  if (request.method === "GET" && new URL(request.url ?? "/", "http://deployer").pathname === "/health") {
    await health(s, response, gatherFacts);
    return;
  }
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
};

const pushHandler = (s: Settings, gatherFacts: typeof gather) => handle((request, response) => push(s, request, response, gatherFacts));

/** The internal push/health HTTP surface, with injectable health observations. */
export const deployerPushHandler = (env: NodeJS.ProcessEnv, gatherFacts: typeof gather = gather) => pushHandler(settings(env), gatherFacts);

const control = async (s: Settings, request: IncomingMessage, response: ServerResponse) => {
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
    accept(s, response, jobRequest(newId(), job, field(input, "dryRun") === true, "manual"));
    return;
  }
  send(response, 404, "not found\n");
};

export const serveDeployer = async (env: NodeJS.ProcessEnv) => {
  const s = settings(env);
  const journal = await startWithLifecycle(join(s.platformDir, "lifecycle"), () => {
    abandon(s);
    createServer(pushHandler(s, gather)).listen(8090);
    createServer(handle((request, response) => control(s, request, response))).listen(8091, "127.0.0.1");
    schedule(s, {
      poll: () => { void poll(s); },
      gc: () => { ask(s, jobRequest(newId(), "gc", false, "schedule")); },
      renovate: () => { ask(s, jobRequest(newId(), "renovate", false, "schedule")); },
    });
    setTimeout(() => { void restore(s); }, restoreAfter);
    console.log(`deployer: :8090 pushes and health, 127.0.0.1:8091 control; renovate ${s.renovate === undefined ? "off" : "on"}`);
  });
  // Keep the lock object reachable until exit; the OS releases it on exit.
  process.once("exit", () => { void journal.close(); });
};
