import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, sep } from "node:path";
import { z } from "zod";
import { milliseconds, within, type KayraRoot, type KayraVersion } from "../../core/fleet/brand.ts";
import { verbose } from "../../core/recipes/steps.ts";
import { opentofu } from "../../core/adapters/opentofu.ts";
import { statusJson } from "./status.ts";
import type { Network, Tofu } from "../../core/status/ports.ts";
import type { Fleet } from "../../core/fleet/model.ts";
import { interpret } from "../../core/interpreter/loop.ts";
import type { Io } from "../../core/interpreter/io.ts";
import { isOperation, operation, type Invocation } from "../../core/operations/catalog.ts";
import { contextFor, hasPlan, invocation, isQuery, isStream, planOf, serverOf, stream } from "../../core/operations/dispatch.ts";
import type { Plan } from "../../core/plan/model.ts";
import { heading, listed, reporting } from "../../core/interpreter/events.ts";
import { follow } from "../../core/status/updates.ts";
import { err, ok } from "../../result.ts";
import { json, send } from "../../deployer/http.ts";
import { catalog, openapi } from "./contract.ts";
import { directories } from "./directories.ts";
import type * as wire from "./contract.gen.ts";
import { facts, words } from "./commands.ts";
import { answer as queryAnswer } from "./queries.ts";
import { options, requestBody } from "./protocol.ts";
import { busy, readRecord, recordLine, runId, stateOf, summary, type Run } from "./runs.ts";
import { typed } from "../../typed.ts";

export type Api = {
  readonly kayra: KayraRoot;
  readonly fleet: Fleet;
  readonly version: KayraVersion;
  readonly short: (text: string) => string;
  readonly network: Network;
  readonly tofu?: Tofu;
};

type Live = {
  readonly run: Run;
  readonly listeners: readonly ((event: wire.RunEvent) => void)[];
  readonly stop: AbortController;
  readonly answer: ((text: string) => void) | undefined;
  readonly input: ((chunk: string) => void) | undefined;
  readonly done: Promise<unknown>;
};
type Settings = Readonly<z.infer<typeof options>>;
type Refusal = readonly [number, string];

const answerJson = (response: ServerResponse, status: number, value: unknown) => {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
};
const events = (response: ServerResponse, ndjson = false) => {
  response.writeHead(200, { "Content-Type": ndjson ? "application/x-ndjson" : "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  return {
    say: (value: unknown) => { if (!response.destroyed) response.write(ndjson ? `${JSON.stringify(value)}\n` : `data: ${JSON.stringify(value)}\n\n`); },
    end: () => { response.end(ndjson ? "" : "event: end\ndata: {}\n\n"); },
  } as const;
};

export const createApi = (api: Api) => {
  // eslint-disable-next-line functional/prefer-immutable-types -- per-listener state; no launch shares locks, credentials or sessions
  const cell: { live: Readonly<Record<string, Live>>; pending: readonly Promise<void>[] } = { live: {}, pending: [] };
  const shutdown = new AbortController();
  const swap = (id: string, change: (live: Live) => Live) => {
    const current = cell.live[id];
    // eslint-disable-next-line functional/immutable-data -- replace the one state cell whole
    if (current !== undefined) cell.live = { ...cell.live, [id]: change(current) };
  };
  const context = contextFor({ kayra: api.kayra, fleet: api.fleet, version: api.version, here: api.fleet.root, network: api.network, tofu: api.tofu ?? opentofu, signal: shutdown.signal });
  const dir = within(api.fleet.root, ".cache", "ui", "runs");
  const allRuns = () => {
    const live = Object.values(cell.live).map((each) => each.run);
    const records = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".jsonl")).flatMap((name) => {
      const run = readRecord(readFileSync(join(dir, name), "utf8"));
      return run === undefined || live.some((each) => each.id === run.id) ? [] : [run];
    }) : [];
    return Object.freeze([...live, ...records].toSorted((a, b) => b.id.localeCompare(a.id)));
  };
  const about = (call: Invocation) => heading(words(call), serverOf(context, call), api.version);
  const recipe = (call: Invocation, settings: Settings) => {
    if (!hasPlan(call)) return err(`${call.name} has no plan`);
    const plan = planOf(context, call);
    return plan.ok && settings.verbose ? ok<Plan>(verbose(plan.value)) : plan;
  };
  const preview = (call: Invocation, settings: Settings) => {
    const plan = recipe(call, settings);
    return plan.ok ? ok<wire.Preview>({ invocation: about(call), steps: listed(plan.value, api.short), changes: operation(call.name).effect !== "reads" }) : plan;
  };
  const start = (call: Invocation, settings: Settings, confirm: string | undefined) => {
    if (shutdown.signal.aborted) return err(typed<Refusal>([503, "kayra is stopping"]));
    const plan = recipe(call, settings);
    if (!plan.ok) return err(typed<Refusal>([400, plan.error]));
    const server = serverOf(context, call);
    if (busy(Object.values(cell.live).map((live) => live.run), server?.name)) return err(typed<Refusal>([409, `a run on ${server?.name ?? ""} has not ended`]));
    if (operation(call.name).effect !== "reads" && server !== undefined && server.target !== "multipass" && confirm !== server.name) return err(typed<Refusal>([403, `this changes ${server.name}: confirm with its name`]));
    const started = new Date().toISOString();
    const id = runId(started, randomBytes(6).toString("hex"));
    const session = operation(call.name).kind === "session";
    const run: Run = { id, command: words(call), started, events: [], session, ...(server === undefined ? {} : { server: server.name }) };
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    appendFileSync(file, recordLine({ id, command: run.command, started, session, ...(server === undefined ? {} : { server: server.name }) }));
    const stop = new AbortController();
    // eslint-disable-next-line functional/immutable-data -- install the lock before any asynchronous work
    cell.live = { ...cell.live, [id]: { run, stop, listeners: [], answer: undefined, input: undefined, done: Promise.resolve() } };
    const emit = (event: wire.RunEvent) => {
      appendFileSync(file, recordLine(event));
      swap(id, (live) => ({ ...live, run: { ...live.run, events: [...live.run.events, event] } } as const));
      cell.live[id]?.listeners.forEach((listener) => { listener(event); });
    };
    const io: Io = {
      out: (text) => { emit({ kind: "said", stream: "out", text }); },
      err: (text) => { emit({ kind: "said", stream: "err", text }); },
      ask: (question) => new Promise<string>((resolve) => {
        swap(id, (live) => ({ ...live, answer: (text) => {
          swap(id, (after) => ({ ...after, answer: undefined }));
          emit({ kind: "answered" });
          resolve(text);
        } } as const));
        emit({ kind: "ask", prompt: question.text, secret: question.kind === "secret", ...(question.kind === "confirm" ? { expect: question.expect } : {}) });
      }),
      output: (chunk, stream) => { emit({ kind: "output", stream, chunk }); },
      input: (deliver) => {
        swap(id, (live) => ({ ...live, input: deliver } as const));
        return () => { swap(id, (live) => ({ ...live, input: undefined } as const)); };
      },
      size: { columns: settings.columns, rows: settings.rows }, signal: stop.signal,
    };
    const coloured = plan.value.map((step) => step.kind === "run" ? { ...step, env: { ...step.env, ANSIBLE_FORCE_COLOR: "1" } } : step);
    const done = interpret(coloured, io, reporting(emit, about(call), api.short)).catch(() => {
      emit({ kind: "said", stream: "err", text: "The run could not finish; check the local kayra process." });
      emit({ kind: "ended", failures: 1, ms: milliseconds(Date.now() - Date.parse(started)), footer: [] });
    }).finally(() => { swap(id, (live) => ({ ...live, answer: undefined, input: undefined } as const)); });
    swap(id, (live) => ({ ...live, done } as const));
    return ok<string>(id);
  };
  const watch = (id: string, response: ServerResponse, ndjson: boolean, session = false) => {
    const live = cell.live[id];
    const run = live?.run ?? allRuns().find((each) => each.id === id);
    if (run === undefined || (session && !run.session)) { send(response, 404, "no run or session\n"); return; }
    const { say, end } = events(response, ndjson);
    run.events.forEach(say);
    if (live === undefined || stateOf(run.events) !== "running") { end(); return; }
    const listener = (event: wire.RunEvent) => { say(event); if (event.kind === "ended") end(); };
    swap(id, (current) => ({ ...current, listeners: [...current.listeners, listener] } as const));
    response.on("close", () => { swap(id, (current) => ({ ...current, listeners: current.listeners.filter((each) => each !== listener) } as const)); });
  };
  const dispatch = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const method = request.method ?? "GET";
    const path = url.pathname;
    const named = /^\/api\/operations\/([^/]+)(\/preview)?$/.exec(path);
    const runPath = /^\/api\/runs\/([^/]+)(?:\/(events|answers|cancel))?$/.exec(path);
    const sessionPath = /^\/api\/sessions\/([^/]+)(?:\/(output|input))?$/.exec(path);
    const ndjson = request.headers.accept?.includes("application/x-ndjson") === true;
    if (method === "GET" && path === "/api/operations") answerJson(response, 200, catalog());
    else if (method === "GET" && path === "/api/openapi.json") answerJson(response, 200, openapi(api.version));
    else if (method === "GET" && path === "/api/directories") {
      const result = await directories(url.searchParams.get("path") ?? ".", api.fleet.root);
      if (result.ok) answerJson(response, 200, result.value); else send(response, 400, `${result.error}\n`);
    }
    else if (method === "GET" && path === "/api/fleet") {
      const factsOfFleet: wire.FleetFacts = { fleet: api.fleet.root.split(sep).at(-1) ?? "", version: api.version, servers: api.fleet.servers.map(facts) };
      answerJson(response, 200, factsOfFleet);
    } else if (method === "POST" && named !== null) {
      const name = decodeURIComponent(named[1] ?? "");
      if (!isOperation(name)) { send(response, 404, "no such operation\n"); return; }
      const body = requestBody.safeParse(await json(request));
      if (!body.success) { send(response, 400, "expected {input, options?, confirm?}\n"); return; }
      const call = invocation(name, body.data.input);
      const settings = options.parse(body.data.options ?? {});
      if (!call.ok) { send(response, 400, `${call.error}\n`); return; }
      const kind = operation(call.value.name).kind;
      if (named[2] !== undefined || settings.dryRun) {
        const shown = preview(call.value, settings);
        if (shown.ok) answerJson(response, 200, shown.value); else send(response, 400, `${shown.error}\n`);
      } else if (kind === "plan" || kind === "session") {
        const started = start(call.value, settings, body.data.confirm);
        if (!started.ok) send(response, started.error[0], `${started.error[1]}\n`);
        else answerJson(response, kind === "session" ? 201 : 202, { [kind === "session" ? "session" : "run"]: started.value });
      } else if (isStream(call.value)) {
        const { initial, updates } = stream(context, call.value.name, call.value.input);
        const sink = events(response, ndjson);
        await follow(initial, updates, (looks) => { const value: wire.Status = statusJson(looks); sink.say(value); });
        sink.end();
      } else if (isQuery(call.value)) {
        const result = await queryAnswer(context, call.value.name, call.value.input);
        if (result.ok) answerJson(response, 200, result.value);
        else send(response, call.value.name === "validate" ? 400 : 502, `${result.error}\n`);
      }

    } else if (method === "GET" && path === "/api/runs") {
      const runs: readonly wire.RunSummary[] = allRuns().map(summary);
      answerJson(response, 200, runs);
    } else if (runPath !== null || sessionPath !== null) {
      const [, id = "", action] = runPath ?? sessionPath ?? [];
      const live = cell.live[id];
      const session = sessionPath !== null;
      if (session && live?.run.session !== true && !allRuns().some((each) => each.id === id && each.session)) { send(response, 404, "no session\n"); return; }
      if (method === "GET" && (action === "events" || action === "output")) watch(id, response, ndjson, session);
      else if (method === "GET" && action === undefined && !session) {
        const run = allRuns().find((each) => each.id === id);
        if (run === undefined) send(response, 404, "no run\n"); else { const value: wire.Run = { ...summary(run), events: run.events }; answerJson(response, 200, value); }
      } else if (((method === "POST" && action === "cancel") || (session && method === "DELETE" && action === undefined)) && live !== undefined && stateOf(live.run.events) === "running") {
        live.stop.abort(); send(response, 204, "");
      } else if (method === "POST" && (action === "answers" || action === "input")) {
        const deliver = action === "answers" ? live?.answer : session ? live?.input : undefined;
        if (deliver === undefined || live?.stop.signal.aborted === true) { send(response, 404, "nothing waiting for input\n"); return; }
        const body = z.strictObject({ text: z.string() }).safeParse(await json(request));
        if (!body.success) send(response, 400, "expected {text: string}\n");
        else { deliver(body.data.text); send(response, 204, ""); }
      } else send(response, 404, "no active resource\n");
    } else send(response, 404, "not found\n");
  };
  const handle = (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const work = dispatch(request, response, url).finally(() => {
      // eslint-disable-next-line functional/immutable-data -- release this request after its response completes
      cell.pending = cell.pending.filter((pending) => pending !== work);
    });
    // eslint-disable-next-line functional/immutable-data -- shutdown waits for in-flight requests as well as runs
    cell.pending = [...cell.pending, work];
    return work;
  };
  return { handle, stop: async () => {
    shutdown.abort();
    Object.values(cell.live).forEach((live) => { live.stop.abort(); });
    await Promise.allSettled([...cell.pending, ...Object.values(cell.live).map((live) => live.done)]);
  } } as const;
};
