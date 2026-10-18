import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, sep } from "node:path";
import { within, type KayraRoot } from "../../core/brand.ts";
import { look, opentofu, statusJson, type Network } from "../../core/commands/status.ts";
import { findings, validateJson } from "../../core/commands/validate.ts";
import { json, send } from "../../deployer/http.ts";
import type { Fleet } from "../../core/fleet.ts";
import { gather } from "../../core/gather.ts";
import { capture, interpret, type Io } from "../../core/interpret.ts";
import type { Plan } from "../../core/plan.ts";
import { err, flatMap, ok, type Result } from "../../result.ts";
import { listed, reporting, type Invocation } from "../../core/present/progress.ts";
import { follow } from "../../core/updates.ts";
import { parsed, releasesSchema, runsSchema } from "../../core/present/views.ts";
import { invocation, isPlan, planOf as planOfCall, type Context } from "../../core/operations/run.ts";
import { changes, commandInput, facts, targetOf, toInvocation, words } from "./commands.ts";
import type * as wire from "./contract.ts";
import { busy, readRecord, recordLine, runId, stateOf, summary, type Run } from "./runs.ts";

/** What the API answers from: the engine, the fleet, and how it names paths and reaches servers. */
export type Api = {
  readonly kayra: KayraRoot;
  readonly fleet: Fleet;
  readonly version: string;
  readonly short: (text: string) => string;
  readonly network: Network;
};

type Live = {
  readonly run: Run;
  readonly listeners: readonly ((event: wire.RunEvent) => void)[];
  readonly stop: AbortController;
  /** The answer a confirmation waits for, while one does. */
  readonly answer: ((text: string) => void) | undefined;
  readonly input: ((chunk: string) => void) | undefined;
};

/** kayra ui's one mutable cell: the runs it started, swapped whole on every change. */
// eslint-disable-next-line functional/prefer-immutable-types -- kayra ui's state lives here, nowhere else
const cell: { live: Readonly<Record<string, Live>> } = { live: {} };

const swap = (id: string, change: (live: Live) => Live): void => {
  const current = cell.live[id];
  // eslint-disable-next-line functional/immutable-data -- kayra ui's state lives here, nowhere else
  if (current !== undefined) cell.live = { ...cell.live, [id]: change(current) };
};

const runsDir = (fleet: Fleet): string => within(fleet.root, ".cache", "ui", "runs");

const recorded = (fleet: Fleet): readonly Run[] => {
  const dir = runsDir(fleet);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => {
      const run = readRecord(readFileSync(join(dir, name), "utf8"));
      return run === undefined ? [] : [run];
    });
};

/** Every run kayra ui knows: those it runs now, and those its records keep. */
const allRuns = (fleet: Fleet): readonly Run[] => {
  const live = Object.values(cell.live).map((each) => each.run);
  return [...live, ...recorded(fleet).filter((run) => !live.some((each) => each.id === run.id))].toSorted((a, b) =>
    b.id.localeCompare(a.id),
  );
};

/** Ansible colours its output for a terminal only; the browser draws the colours too. */
const coloured = (plan: Plan): Plan =>
  plan.map((step) => (step.kind === "run" || step.kind === "session" ? { ...step, env: { ...step.env, ANSIBLE_FORCE_COLOR: "1" } } : step));

/** A server-sent stream; `end` says everything is said, so the browser closes instead of reconnecting. */
const sse = (response: ServerResponse): { readonly say: (data: unknown) => void; readonly end: () => void } => {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  return {
    say: (data) => {
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    end: () => {
      response.end("event: end\ndata: {}\n\n");
    },
  };
};

const answerJson = (response: ServerResponse, status: number, value: unknown): void => {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
};

const invocationOf = (ui: Api, input: wire.CommandInput): Result<Invocation, string> =>
  flatMap(targetOf(ui.fleet, input), (target) =>
    ok({
      command: words(input),
      ...(target === undefined ? {} : { server: target.name }),
      about: [...(target === undefined ? [] : [`${target.kind} on ${target.target}`, target.domain]), `kayra ${ui.version}`],
    }),
  );

/** The core's context for the fleet this server serves; paths start at the fleet. */
const contextOf = (ui: Api): Context => ({
  engine: { kayra: ui.kayra, fleet: ui.fleet.root },
  fleet: ui.fleet,
  version: ui.version,
  here: ui.fleet.root,
  read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
  network: ui.network,
  tofu: opentofu,
});

const planOf = (ui: Api, input: wire.CommandInput): Result<Plan, string> =>
  flatMap(toInvocation(input), (call) => (isPlan(call) ? planOfCall(contextOf(ui), call) : err(`${call.name} runs no plan`)));

const preview = (ui: Api, input: wire.CommandInput): Result<wire.Preview, string> =>
  flatMap(planOf(ui, input), (plan) =>
    flatMap(invocationOf(ui, input), (invocation) => ok({ invocation, steps: listed(plan, ui.short), changes: changes(input) })),
  );

/** Starts a run, or says why it cannot: one per server, a real server not confirmed. */
const start = (ui: Api, input: wire.CommandInput, confirm: unknown): Result<string, readonly [number, string]> => {
  const target = targetOf(ui.fleet, input);
  const plan = planOf(ui, input);
  const invocation = invocationOf(ui, input);
  if (!target.ok || !plan.ok || !invocation.ok) return err([400, [target, plan, invocation].flatMap((each) => (each.ok ? [] : [each.error])).join("; ")]);
  const server = target.value;
  if (busy(allRuns(ui.fleet), server?.name)) return err([409, `a run on ${server?.name ?? ""} has not ended`]);
  if (changes(input) && server !== undefined && server.target !== "multipass" && confirm !== server.name)
    return err([403, `this changes ${server.name}: confirm with its name`]);
  const started = new Date().toISOString();
  const id = runId(started, randomBytes(3).toString("hex"));
  const run: Run = { id, command: words(input), ...(server === undefined ? {} : { server: server.name }), started, events: [] };
  const file = join(runsDir(ui.fleet), `${id}.jsonl`);
  mkdirSync(runsDir(ui.fleet), { recursive: true });
  appendFileSync(file, recordLine({ id: run.id, command: run.command, ...(server === undefined ? {} : { server: server.name }), started }));
  // eslint-disable-next-line functional/immutable-data -- kayra ui's state lives here, nowhere else
  cell.live = { ...cell.live, [id]: { run, listeners: [], stop: new AbortController(), answer: undefined, input: undefined } };
  const emit = (event: wire.RunEvent): void => {
    appendFileSync(file, recordLine(event));
    swap(id, (live) => ({ ...live, run: { ...live.run, events: [...live.run.events, event] } }));
    cell.live[id]?.listeners.forEach((listener) => {
      listener(event);
    });
  };
  const stop = cell.live[id]?.stop;
  const io: Io = {
    out: (text) => {
      emit({ kind: "said", stream: "out", text });
    },
    err: (text) => {
      emit({ kind: "said", stream: "err", text });
    },
    ask: (question) =>
      new Promise((resolve) => {
        swap(id, (live) => ({
          ...live,
          answer: (text) => {
            swap(id, (after) => ({ ...after, answer: undefined }));
            emit({ kind: "answered" });
            resolve(text);
          },
        }));
        emit({ kind: "ask", prompt: question.text, secret: question.kind === "secret", ...(question.kind === "confirm" ? { expect: question.expect } : {}) });
      }),
    input: (deliver) => {
      swap(id, (live) => ({ ...live, input: deliver }));
      return () => { swap(id, (live) => ({ ...live, input: undefined })); };
    },
    output: (chunk, stream) => {
      emit({ kind: "output", stream, chunk });
    },
    ...(stop === undefined ? {} : { signal: stop.signal }),
  };
  void interpret(coloured(plan.value), io, reporting(emit, invocation.value, ui.short), () => stop?.signal.aborted === true).finally(() => {
    swap(id, (live) => ({ ...live, answer: undefined, input: undefined }));
  });
  return ok(id);
};

/** A run's events from the start, then each as it happens, until it has ended. */
const watchRun = (ui: Api, id: string, response: ServerResponse): void => {
  const live = cell.live[id];
  const run = live?.run ?? recorded(ui.fleet).find((each) => each.id === id);
  if (run === undefined) {
    send(response, 404, `no run ${id}\n`);
    return;
  }
  const { say, end } = sse(response);
  run.events.forEach(say);
  if (live === undefined || stateOf(run.events) !== "running") {
    end();
    return;
  }
  const listener = (event: wire.RunEvent): void => {
    say(event);
    if (event.kind === "ended") end();
  };
  swap(id, (current) => ({ ...current, listeners: [...current.listeners, listener] }));
  response.on("close", () => {
    swap(id, (current) => ({ ...current, listeners: current.listeners.filter((each) => each !== listener) }));
  });
};

/** What a deployer's ctl answers, captured over SSH as the command line asks it. */
const ctl = async (ui: Api, name: "app.runs" | "app.log" | "app.releases", input: Readonly<Record<string, string>>): Promise<Result<string, string>> => {
  const call = invocation(name, input);
  if (!call.ok) return call;
  const plan = isPlan(call.value) ? planOfCall(contextOf(ui), call.value) : err(`${name} runs no plan`);
  if (!plan.ok) return plan;
  const [step] = plan.value;
  if (step?.kind !== "run") return err("the deployer's plan has no step");
  const [program, ...args] = step.argv;
  const argv = args.flatMap((arg) => (typeof arg === "string" ? [arg] : []));
  const exit = await capture([program, ...argv], "capture");
  return exit.code === 0 ? ok(exit.stdout) : err(exit.stderr.trim() === "" ? `exit ${String(exit.code)}` : exit.stderr.trim());
};

/** A request to /api/, admitted by the host that serves it. */
export const handleApi = async (ui: Api, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
  const path = url.pathname;
  const method = request.method ?? "GET";
  const app = /^\/api\/servers\/([^/]+)\/apps\/([^/]+)\/(runs|releases|logs)(?:\/([^/]+))?$/.exec(path);
  const runPath = /^\/api\/runs\/([^/]+)\/(events|answer|cancel|input)$/.exec(path);
  if (method === "GET" && path === "/api/fleet") {
    const fleetFacts: wire.FleetFacts = { fleet: ui.fleet.root.split(sep).at(-1) ?? "", version: ui.version, servers: ui.fleet.servers.map(facts) };
    answerJson(response, 200, fleetFacts);
  } else if (method === "GET" && path === "/api/status") {
    const { say, end } = sse(response);
    const { initial, updates } = look(ui.fleet, opentofu, ui.network);
    await follow(initial, updates, (looks) => {
      const status: wire.Status = statusJson(looks);
      say(status);
    });
    end();
  } else if (method === "GET" && path === "/api/validate") {
    const reports = await Promise.all(ui.fleet.servers.map(async (server) => ({ server, findings: findings(await gather(ui.fleet.root, server)) })));
    const validation: wire.Validation = validateJson(reports);
    answerJson(response, 200, validation);
  } else if (method === "GET" && app !== null) {
    const [, server = "", name = "", what, more] = app;
    const asked = { server: decodeURIComponent(server), app: decodeURIComponent(name) };
    const answer = await ctl(ui, what === "runs" ? "app.runs" : what === "releases" ? "app.releases" : "app.log", {
      ...asked,
      ...(more === undefined ? {} : { run: decodeURIComponent(more) }),
    });
    if (!answer.ok) send(response, 502, `${answer.error}\n`);
    else if (what === "logs") send(response, 200, answer.value);
    else {
      const value: wire.AppRuns | wire.AppReleases | undefined = what === "runs" ? parsed(runsSchema, answer.value) : parsed(releasesSchema, answer.value);
      if (value === undefined) send(response, 502, "the server's deployer answered in a form this kayra does not read: deploy it with this kayra\n");
      else answerJson(response, 200, value);
    }
  } else if (method === "POST" && path === "/api/plan") {
    const input = commandInput.safeParse(await json(request));
    const shown = input.success ? preview(ui, input.data) : err(input.error.issues.at(0)?.message ?? "not a command");
    if (shown.ok) answerJson(response, 200, shown.value);
    else send(response, 400, `${shown.error}\n`);
  } else if (method === "GET" && path === "/api/runs") {
    const runs: readonly wire.RunSummary[] = allRuns(ui.fleet).slice(0, 50).map(summary);
    answerJson(response, 200, runs);
  } else if (method === "POST" && path === "/api/runs") {
    const body = await json(request);
    const input = commandInput.safeParse(typeof body === "object" && body !== null && "command" in body ? body.command : undefined);
    const confirm = typeof body === "object" && body !== null && "confirm" in body ? body.confirm : undefined;
    const started = input.success ? start(ui, input.data, confirm) : err([400, input.error.issues.at(0)?.message ?? "not a command"] as const);
    if (started.ok) answerJson(response, 201, { id: started.value });
    else send(response, started.error[0], `${started.error[1]}\n`);
  } else if (runPath !== null) {
    const [, id = "", what] = runPath;
    const live = cell.live[id];
    if (method === "GET" && what === "events") watchRun(ui, id, response);
    else if (method === "POST" && what === "cancel" && live !== undefined) {
      live.stop.abort();
      send(response, 202, "stopping\n");
    } else if (method === "POST" && what === "input" && live?.input !== undefined) {
      const body = await json(request);
      if (typeof body !== "object" || body === null || !("text" in body) || typeof body.text !== "string") send(response, 400, "input needs text\n");
      else {
        live.input(body.text);
        send(response, 204, "");
      }
    } else if (method === "POST" && what === "answer" && live?.answer !== undefined) {
      const body = await json(request);
      live.answer(typeof body === "object" && body !== null && "text" in body && typeof body.text === "string" ? body.text : "");
      send(response, 204, "");
    } else send(response, 404, `nothing to ${what ?? ""} for run ${id}\n`);
  } else send(response, 404, "not found\n");
};

/** Stops every run this server started: it is going away. */
export const stopRuns = (): void => {
  Object.values(cell.live).forEach((live) => {
    live.stop.abort();
  });
};
