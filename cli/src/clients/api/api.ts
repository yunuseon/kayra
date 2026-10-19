import type { IncomingMessage, ServerResponse } from "node:http";
import { sep } from "node:path";
import { z } from "zod";
import { within, type KayraRoot, type KayraVersion } from "../../core/fleet/brand.ts";
import type { Fleet } from "../../core/fleet/model.ts";
import { opentofu } from "../../core/adapters/opentofu.ts";
import { isOperation, operation } from "../../core/operations/catalog.ts";
import { contextFor, invocation, isQuery, isStream, stream } from "../../core/operations/dispatch.ts";
import type { Network, Tofu } from "../../core/status/ports.ts";
import { follow } from "../../core/status/updates.ts";
import { json, send } from "../../deployer/http.ts";
import { facts } from "./commands.ts";
import type * as wire from "./contract.gen.ts";
import { catalog, openapi } from "./contract.ts";
import { directories } from "./directories.ts";
import { inFlight, liveRuns } from "./live.ts";
import { options, requestBody } from "./protocol.ts";
import { answer as queryAnswer } from "./queries.ts";
import { stateOf, summary } from "./runs.ts";
import { allRuns, preview, start, type Served } from "./start.ts";
import { statusJson } from "./status.ts";

export type Api = {
  readonly kayra: KayraRoot;
  readonly fleet: Fleet;
  readonly version: KayraVersion;
  readonly short: (text: string) => string;
  readonly network: Network;
  readonly tofu?: Tofu;
};

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

/** A run's events as they come, after those it has had: until it ends, or the client goes. */
const watch = (served: Served, id: string, response: ServerResponse, ndjson: boolean, session = false) => {
  const live = served.runs.get(id);
  const run = live?.run ?? allRuns(served).find((each) => each.id === id);
  if (run === undefined || (session && !run.session)) { send(response, 404, "no run or session\n"); return; }
  const { say, end } = events(response, ndjson);
  run.events.forEach(say);
  if (live === undefined || stateOf(run.events) !== "running") { end(); return; }
  const listener = (event: wire.RunEvent) => { say(event); if (event.kind === "ended") end(); };
  served.runs.swap(id, (current) => ({ ...current, listeners: [...current.listeners, listener] }));
  response.on("close", () => { served.runs.swap(id, (current) => ({ ...current, listeners: current.listeners.filter((each) => each !== listener) })); });
};

/** POST /api/operations/<name>[/preview]: a plan previewed or started, a session started, a query answered, a stream followed. */
const operate = async (served: Served, request: IncomingMessage, response: ServerResponse, named: string, previewing: boolean, ndjson: boolean) => {
  const name = decodeURIComponent(named);
  if (!isOperation(name)) { send(response, 404, "no such operation\n"); return; }
  const body = requestBody.safeParse(await json(request));
  if (!body.success) { send(response, 400, "expected {input, options?, confirm?}\n"); return; }
  const call = invocation(name, body.data.input);
  const settings = options.parse(body.data.options ?? {});
  if (!call.ok) { send(response, 400, `${call.error}\n`); return; }
  const kind = operation(call.value.name).kind;
  if (previewing || settings.dryRun) {
    const shown = preview(served, call.value, settings);
    if (shown.ok) answerJson(response, 200, shown.value); else send(response, 400, `${shown.error}\n`);
  } else if (kind === "plan" || kind === "session") {
    const started = start(served, call.value, settings, body.data.confirm);
    if (!started.ok) send(response, started.error[0], `${started.error[1]}\n`);
    else answerJson(response, kind === "session" ? 201 : 202, { [kind === "session" ? "session" : "run"]: started.value });
  } else if (isStream(call.value)) {
    const { initial, updates } = stream(served.context, call.value.name, call.value.input);
    const sink = events(response, ndjson);
    await follow(initial, updates, (looks) => { const value: wire.Status = statusJson(looks); sink.say(value); });
    sink.end();
  } else if (isQuery(call.value)) {
    const result = await queryAnswer(served.context, call.value.name, call.value.input);
    if (result.ok) answerJson(response, 200, result.value);
    else send(response, call.value.name === "validate" ? 400 : 502, `${result.error}\n`);
  }
};

/** /api/runs/<id>[/events|answers|cancel] and /api/sessions/<id>[/output|input]: follow, answer, stop. */
const steer = async (served: Served, request: IncomingMessage, response: ServerResponse, id: string, action: string | undefined, session: boolean, ndjson: boolean) => {
  const method = request.method ?? "GET";
  const live = served.runs.get(id);
  if (session && live?.run.session !== true && !allRuns(served).some((each) => each.id === id && each.session)) { send(response, 404, "no session\n"); return; }
  if (method === "GET" && (action === "events" || action === "output")) watch(served, id, response, ndjson, session);
  else if (method === "GET" && action === undefined && !session) {
    const run = allRuns(served).find((each) => each.id === id);
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
};

/** The API of one listener: its requests routed, and a stop that waits for runs and requests to end. */
export const createApi = (api: Api) => {
  const shutdown = new AbortController();
  const served: Served = {
    api,
    context: contextFor({ kayra: api.kayra, fleet: api.fleet, version: api.version, here: api.fleet.root, network: api.network, tofu: api.tofu ?? opentofu, signal: shutdown.signal }),
    runs: liveRuns(),
    dir: within(api.fleet.root, ".cache", "ui", "runs"),
    shutdown,
  };
  const requests = inFlight();
  const route = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
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
    } else if (method === "GET" && path === "/api/fleet") {
      const factsOfFleet: wire.FleetFacts = { fleet: api.fleet.root.split(sep).at(-1) ?? "", version: api.version, servers: api.fleet.servers.map(facts) };
      answerJson(response, 200, factsOfFleet);
    } else if (method === "POST" && named !== null) await operate(served, request, response, named[1] ?? "", named[2] !== undefined, ndjson);
    else if (method === "GET" && path === "/api/runs") {
      const runs: readonly wire.RunSummary[] = allRuns(served).map(summary);
      answerJson(response, 200, runs);
    } else if (runPath !== null || sessionPath !== null) {
      const [, id = "", action] = runPath ?? sessionPath ?? [];
      await steer(served, request, response, id, action, sessionPath !== null, ndjson);
    } else send(response, 404, "not found\n");
  };
  return {
    handle: (request: IncomingMessage, response: ServerResponse, url: URL) => requests.track(route(request, response, url)),
    stop: async () => {
      shutdown.abort();
      served.runs.all().forEach((live) => { live.stop.abort(); });
      await Promise.allSettled([requests.settled(), ...served.runs.all().map((live) => live.done)]);
    },
  } as const;
};
