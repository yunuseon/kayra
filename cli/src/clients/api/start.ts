import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { milliseconds, type AbsolutePath } from "../../core/fleet/brand.ts";
import { heading, listed, reporting } from "../../core/interpreter/events.ts";
import type { Io } from "../../core/interpreter/io.ts";
import { interpret } from "../../core/interpreter/loop.ts";
import { operation, type Invocation } from "../../core/operations/catalog.ts";
import { hasPlan, planOf, serverOf, type Context } from "../../core/operations/dispatch.ts";
import type { Plan } from "../../core/plan/model.ts";
import { verbose } from "../../core/recipes/steps.ts";
import { err, ok } from "../../result.ts";
import { typed } from "../../typed.ts";
import type { Api } from "./api.ts";
import { words } from "./commands.ts";
import type * as wire from "./contract.gen.ts";
import type { LiveRuns } from "./live.ts";
import type { options } from "./protocol.ts";
import { busy, readRecord, recordLine, runId, type Run } from "./runs.ts";

/** What one listener serves with: its fleet, the core's context, its runs and where they are recorded. */
export type Served = {
  readonly api: Api;
  readonly context: Context;
  readonly runs: LiveRuns;
  /** `.cache/ui/runs/`: a run's events as JSON lines. */
  readonly dir: AbsolutePath;
  readonly shutdown: AbortController;
};

export type Settings = Readonly<z.infer<typeof options>>;

/** Why a run was not started: the HTTP status, and the reason. */
type Refusal = readonly [number, string];

/** Every run there is: the live ones, then those recorded, newest first. */
export const allRuns = (served: Served) => {
  const live = served.runs.all().map((each) => each.run);
  const records = existsSync(served.dir)
    ? readdirSync(served.dir).filter((name) => name.endsWith(".jsonl")).flatMap((name) => {
        const run = readRecord(readFileSync(join(served.dir, name), "utf8"));
        return run === undefined || live.some((each) => each.id === run.id) ? [] : [run];
      })
    : [];
  return Object.freeze([...live, ...records].toSorted((a, b) => b.id.localeCompare(a.id)));
};

const about = (served: Served, call: Invocation) => heading(words(call), serverOf(served.context, call), served.api.version);

const recipe = (served: Served, call: Invocation, settings: Settings) => {
  if (!hasPlan(call)) return err(`${call.name} has no plan`);
  const plan = planOf(served.context, call);
  return plan.ok && settings.verbose ? ok<Plan>(verbose(plan.value)) : plan;
};

/** The plan an operation would run, as the browser lists it. */
export const preview = (served: Served, call: Invocation, settings: Settings) => {
  const plan = recipe(served, call, settings);
  return plan.ok
    ? ok<wire.Preview>({ invocation: about(served, call), steps: listed(plan.value, served.api.short), changes: operation(call.name).effect !== "reads" })
    : plan;
};

/**
 * A plan or a session, started: recorded as it goes, its questions and input
 * answered over HTTP. A change to a server that is not multipass needs its
 * name in `confirm`; one run per server at a time.
 */
export const start = (served: Served, call: Invocation, settings: Settings, confirm: string | undefined) => {
  const { runs } = served;
  if (served.shutdown.signal.aborted) return err(typed<Refusal>([503, "kayra is stopping"]));
  const plan = recipe(served, call, settings);
  if (!plan.ok) return err(typed<Refusal>([400, plan.error]));
  const server = serverOf(served.context, call);
  if (busy(runs.all().map((live) => live.run), server?.name)) return err(typed<Refusal>([409, `a run on ${server?.name ?? ""} has not ended`]));
  if (operation(call.name).effect !== "reads" && server !== undefined && server.target !== "multipass" && confirm !== server.name)
    return err(typed<Refusal>([403, `this changes ${server.name}: confirm with its name`]));
  const started = new Date().toISOString();
  const id = runId(started, randomBytes(6).toString("hex"));
  const session = operation(call.name).kind === "session";
  const run: Run = { id, command: words(call), started, events: [], session, ...(server === undefined ? {} : { server: server.name }) };
  mkdirSync(served.dir, { recursive: true });
  const file = join(served.dir, `${id}.jsonl`);
  appendFileSync(file, recordLine({ id, command: run.command, started, session, ...(server === undefined ? {} : { server: server.name }) }));
  const stop = new AbortController();
  runs.add(id, { run, stop, listeners: [], answer: undefined, input: undefined, done: Promise.resolve() });
  const emit = (event: wire.RunEvent) => {
    appendFileSync(file, recordLine(event));
    runs.swap(id, (live) => ({ ...live, run: { ...live.run, events: [...live.run.events, event] } }));
    runs.get(id)?.listeners.forEach((listener) => { listener(event); });
  };
  const io: Io = {
    out: (text) => { emit({ kind: "said", stream: "out", text }); },
    err: (text) => { emit({ kind: "said", stream: "err", text }); },
    ask: (question) => new Promise<string>((resolve) => {
      runs.swap(id, (live) => ({ ...live, answer: (text) => {
        runs.swap(id, (after) => ({ ...after, answer: undefined }));
        emit({ kind: "answered" });
        resolve(text);
      } }));
      emit({ kind: "ask", prompt: question.text, secret: question.kind === "secret", ...(question.kind === "confirm" ? { expect: question.expect } : {}) });
    }),
    output: (chunk, stream) => { emit({ kind: "output", stream, chunk }); },
    input: (deliver) => {
      runs.swap(id, (live) => ({ ...live, input: deliver }));
      return () => { runs.swap(id, (live) => ({ ...live, input: undefined })); };
    },
    size: { columns: settings.columns, rows: settings.rows },
    signal: stop.signal,
  };
  const coloured = plan.value.map((step) => (step.kind === "run" ? { ...step, env: { ...step.env, ANSIBLE_FORCE_COLOR: "1" } } : step));
  const done = interpret(coloured, io, reporting(emit, about(served, call), served.api.short)).catch(() => {
    emit({ kind: "said", stream: "err", text: "The run could not finish; check the local kayra process." });
    emit({ kind: "ended", failures: 1, ms: milliseconds(Date.now() - Date.parse(started)), footer: [] });
  }).finally(() => { runs.swap(id, (live) => ({ ...live, answer: undefined, input: undefined })); });
  runs.swap(id, (live) => ({ ...live, done }));
  return ok<string>(id);
};
