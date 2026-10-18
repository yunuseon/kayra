import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";
import type { Arg, Argv, Env, Plan, Probe, Step } from "./plan.ts";
import { all, err, flatMap, ok, type Result } from "../result.ts";
import { active, bad, muted, ok as fine, strong, type Line, type Text } from "./present/line.ts";
import { position, silent, type Done, type Ended, type Progress } from "./present/progress.ts";
import { draw } from "./present/views.ts";

/** Where the interpreter talks to the operator. */
export type Io = {
  /** What a command reports: doctor's checks, notes. */
  readonly out: (text: Text) => void;
  /** Around it: why a step stopped the plan, what a quiet step said, a warning before a question. */
  readonly err: (text: Text) => void;
  readonly ask: (prompt: Text) => Promise<string>;
  /**
   * Without a terminal (the web interface): what a step shows arrives here
   * instead, and no step reads stdin. Without it, steps share kayra's terminal.
   */
  readonly output?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Stops the running step: SIGINT to its program, SIGTERM if it is still there after a while. */
  readonly signal?: Stopping;
};

/** What kayra uses of an AbortSignal. */
type Stopping = {
  readonly aborted: boolean;
  readonly addEventListener: (type: "abort", listener: () => void, options: { readonly once: true }) => void;
  readonly removeEventListener: (type: "abort", listener: () => void) => void;
};

/** Where a program's streams go: kayra's terminal, or the sink and signal of an Io without one. */
type Plumbing = Pick<Io, "output" | "signal">;
const terminal: Plumbing = {};

/** A program that ignores SIGINT this long gets SIGTERM. */
const patience = 10_000;

/** `started` is false if the program could not be run at all; `stderr` then says why. */
type Exit = { readonly code: number; readonly stdout: string; readonly stderr: string; readonly started: boolean };

type Streams = { readonly stdout: "show" | "capture" | "discard"; readonly stderr: "show" | "capture" };

const spawned = async (argv: Argv, streams: Streams, env: Env = {}, plumbing: Plumbing = terminal): Promise<Exit> => {
  const [program, ...args] = argv;
  const { output, signal } = plumbing;
  if (signal?.aborted === true) return { code: 130, stdout: "", stderr: "", started: false };
  const shown = (stream: "show" | "capture" | "discard"): "inherit" | "pipe" | "ignore" =>
    stream === "show" ? (output === undefined ? "inherit" : "pipe") : stream === "capture" ? "pipe" : "ignore";
  const child = spawn(program, args, {
    env: { ...process.env, ...env },
    stdio: [output === undefined ? "inherit" : "ignore", shown(streams.stdout), shown(streams.stderr)],
  });
  const forward = (from: "stdout" | "stderr", sink: (chunk: string, stream: "stdout" | "stderr") => void): void => {
    child[from]?.setEncoding("utf8").on("data", (chunk: string) => {
      sink(chunk, from);
    });
  };
  if (output !== undefined && streams.stdout === "show") forward("stdout", output);
  if (output !== undefined && streams.stderr === "show") forward("stderr", output);
  const read = (from: "stdout" | "stderr", stream: "show" | "capture" | "discard"): Promise<string> => {
    const piped = child[from];
    return piped === null || stream !== "capture" ? Promise.resolve("") : text(piped);
  };
  const stdout = read("stdout", streams.stdout);
  const stderr = read("stderr", streams.stderr);
  const stop = (): void => {
    child.kill("SIGINT");
    setTimeout(() => child.kill("SIGTERM"), patience).unref();
  };
  signal?.addEventListener("abort", stop, { once: true });
  const exit = await new Promise<number | Error>((resolve) => {
    child.on("error", resolve);
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
  signal?.removeEventListener("abort", stop);
  return exit instanceof Error
    ? { code: 127, stdout: "", stderr: exit.message, started: false }
    : { code: exit, stdout: await stdout, stderr: await stderr, started: true };
};

/** A command's stdout, for kayra to read; its stderr reaches the operator unless captured too. */
export const capture = (argv: Argv, stderr: "show" | "capture" = "show", env: Env = {}, plumbing: Plumbing = terminal): Promise<Exit> =>
  spawned(argv, { stdout: "capture", stderr }, env, plumbing);

const answer = (probe: Probe, plumbing: Plumbing): Promise<Exit> =>
  spawned(
    probe.kind === "on-path" ? ["sh", "-c", 'command -v "$1"', "sh", probe.program] : probe.argv,
    { stdout: "discard", stderr: "capture" },
    probe.kind === "exits-zero" ? probe.env : {},
    plumbing,
  );

/** Each query's answer in place of it, as `$(…)` would: one word, or split into many. */
const resolve = async (argv: readonly [string, ...Arg[]], plumbing: Plumbing): Promise<Result<Argv, string>> => {
  const words = await Promise.all(
    argv.map(async (value): Promise<Result<readonly string[], string>> => {
      if (typeof value === "string") return ok([value]);
      const exit = await capture(value.argv, "show", value.env, plumbing);
      if (exit.code !== 0) return err(`$(${value.argv.join(" ")}) failed: exit ${String(exit.code)}`);
      const output = exit.stdout.replace(/\n+$/, "");
      return ok(value.words === "one" ? [output] : output.split(/\s+/).filter((word) => word !== ""));
    }),
  );
  return flatMap(all(words), (lists): Result<Argv, string> => {
    const [program, ...rest] = lists.flat();
    return program === undefined ? err("the command is empty") : ok([program, ...rest]);
  });
};

const lines = (text: string): readonly string[] =>
  text
    .trimEnd()
    .split("\n")
    .filter((line) => line !== "");

/** Under the step's own line. */
const detail = (line: string): Line => ["    ", line];
const aside = (line: string): Line => ["    ", muted(line)];
const hint = (text: string | undefined): readonly Line[] => (text === undefined ? [] : [["    ", active("→"), " ", text]]);

/** How a step went, and what it has to say: printed once its spinner is gone. */
type Outcome = Done & { readonly out: readonly Text[]; readonly err: readonly Text[] };
const goOn: Outcome = { failed: false, stopped: false, out: [], err: [] };

const check = async (step: Extract<Step, { kind: "check" }>, plumbing: Plumbing): Promise<Outcome> => {
  const exit = await answer(step.probe, plumbing);
  const said = [...lines(exit.stderr).map(detail), ...hint(step.hint)];
  if (step.onFailure === "stop") return exit.code === 0 ? goOn : { failed: true, stopped: true, out: [], err: said };
  return exit.code === 0
    ? { ...goOn, out: [[fine("✓"), " ", step.label]] }
    : { failed: true, stopped: false, out: [[bad("✗"), " ", step.label], ...said], err: [] };
};

const runStep = async (step: Extract<Step, { kind: "run" }>, plumbing: Plumbing): Promise<Outcome> => {
  const argv = await resolve(step.argv, plumbing);
  if (!argv.ok) return { failed: true, stopped: true, why: "a query failed", out: [], err: [detail(argv.error)] };
  const { stdout } = step;
  // A quiet step's stderr waits until it is done, so it cannot tear through a spinner.
  const quiet = stdout === "discard";
  const exit = await spawned(
    argv.value,
    { stdout: typeof stdout === "string" ? stdout : "capture", stderr: quiet ? "capture" : "show" },
    step.env,
    plumbing,
  );
  if (!exit.started) return { failed: true, stopped: true, why: "not started", out: [], err: [detail(`${argv.value[0]}: ${exit.stderr}`)] };
  // Whatever it answered is shown, even when it failed: it may say why.
  const out = typeof stdout === "string" ? [] : draw(stdout, exit.stdout, Date.now());
  if (exit.code === 0) return { ...goOn, out, err: lines(exit.stderr).map(aside) };
  return { failed: true, stopped: true, why: `exit ${String(exit.code)}`, out, err: lines(exit.stderr).map(detail) };
};

const perform = async (step: Step, io: Io): Promise<Outcome> => {
  switch (step.kind) {
    case "run":
      return runStep(step, io);
    case "check":
      return check(step, io);
    case "confirm": {
      io.err("");
      io.err(["  ", bad("▲"), " ", strong(step.warning)]);
      const typed = await io.ask(["    Type ", strong(step.expect), " to confirm: "]);
      return typed === step.expect ? goOn : { failed: false, stopped: true, out: ["Aborted."], err: [] };
    }
    case "note":
      return { ...goOn, out: [step.text] };
  }
};

/**
 * Runs a plan step by step, until it ends or a step stops it, shown by `progress`.
 * True if nothing failed and the operator did not interrupt it.
 */
export const interpret = async (
  plan: Plan,
  io: Io,
  progress: Progress = silent,
  interrupted: () => boolean = () => false,
): Promise<boolean> => {
  const ended = await progress.plan(plan, () =>
    plan.reduce<Promise<Ended>>(async (previous, step, index) => {
      const so = await previous;
      if (so.stop !== undefined) return so;
      const done = await progress.step(step, position(plan, index), () => perform(step, io));
      // Ctrl-C reached the step's program too: how it ended says nothing about the server.
      if (interrupted()) return { failures: so.failures, stop: { index, step, why: "interrupted" } };
      done.out.forEach(io.out);
      done.err.forEach(io.err);
      const failures = so.failures + (done.failed ? 1 : 0);
      if (done.stopped) return { failures, stop: { index, step, why: done.failed ? "failed" : "declined" } };
      return { failures };
    }, Promise.resolve({ failures: 0 })),
  );
  return ended.failures === 0 && ended.stop?.why !== "interrupted";
};
