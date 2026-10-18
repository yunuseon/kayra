import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";
import type { Arg, Argv, Env, Plan, Probe, Step } from "./plan.ts";
import { all, err, flatMap, ok, type Result } from "./result.ts";
import { active, bad, muted, ok as fine, strong, type Line, type Text } from "./ui/line.ts";
import { position, silent, type Done, type Ended, type Progress } from "./ui/progress.ts";

/** Where the interpreter talks to the operator. */
export type Io = {
  /** What a command reports: doctor's checks, notes. */
  readonly out: (text: Text) => void;
  /** Around it: why a step stopped the plan, what a quiet step said, a warning before a question. */
  readonly err: (text: Text) => void;
  readonly ask: (prompt: Text) => Promise<string>;
};

/** `started` is false if the program could not be run at all; `stderr` then says why. */
type Exit = { readonly code: number; readonly stdout: string; readonly stderr: string; readonly started: boolean };

type Streams = { readonly stdout: "show" | "capture" | "discard"; readonly stderr: "show" | "capture" };

const spawned = async (argv: Argv, streams: Streams, env: Env = {}): Promise<Exit> => {
  const [program, ...args] = argv;
  const child = spawn(program, args, {
    env: { ...process.env, ...env },
    stdio: [
      "inherit",
      streams.stdout === "show" ? "inherit" : streams.stdout === "capture" ? "pipe" : "ignore",
      streams.stderr === "show" ? "inherit" : "pipe",
    ],
  });
  const stdout = child.stdout === null ? Promise.resolve("") : text(child.stdout);
  const stderr = child.stderr === null ? Promise.resolve("") : text(child.stderr);
  const exit = await new Promise<number | Error>((resolve) => {
    child.on("error", resolve);
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
  return exit instanceof Error
    ? { code: 127, stdout: "", stderr: exit.message, started: false }
    : { code: exit, stdout: await stdout, stderr: await stderr, started: true };
};

/** A command's stdout, for kayra to read; its stderr reaches the operator unless captured too. */
export const capture = (argv: Argv, stderr: "show" | "capture" = "show", env: Env = {}): Promise<Exit> =>
  spawned(argv, { stdout: "capture", stderr }, env);

const answer = (probe: Probe): Promise<Exit> =>
  spawned(
    probe.kind === "on-path" ? ["sh", "-c", 'command -v "$1"', "sh", probe.program] : probe.argv,
    { stdout: "discard", stderr: "capture" },
    probe.kind === "exits-zero" ? probe.env : {},
  );

/** Each query's answer in place of it, as `$(…)` would: one word, or split into many. */
const resolve = async (argv: readonly [string, ...Arg[]]): Promise<Result<Argv, string>> => {
  const words = await Promise.all(
    argv.map(async (value): Promise<Result<readonly string[], string>> => {
      if (typeof value === "string") return ok([value]);
      const exit = await capture(value.argv, "show", value.env);
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

const check = async (step: Extract<Step, { kind: "check" }>): Promise<Outcome> => {
  const exit = await answer(step.probe);
  const said = [...lines(exit.stderr).map(detail), ...hint(step.hint)];
  if (step.onFailure === "stop") return exit.code === 0 ? goOn : { failed: true, stopped: true, out: [], err: said };
  return exit.code === 0
    ? { ...goOn, out: [[fine("✓"), " ", step.label]] }
    : { failed: true, stopped: false, out: [[bad("✗"), " ", step.label], ...said], err: [] };
};

const runStep = async (step: Extract<Step, { kind: "run" }>): Promise<Outcome> => {
  const argv = await resolve(step.argv);
  if (!argv.ok) return { failed: true, stopped: true, why: "a query failed", out: [], err: [detail(argv.error)] };
  // A quiet step's stderr waits until it is done, so it cannot tear through a spinner.
  const quiet = step.stdout === "discard";
  const exit = await spawned(argv.value, { stdout: step.stdout, stderr: quiet ? "capture" : "show" }, step.env);
  if (!exit.started) return { failed: true, stopped: true, why: "not started", out: [], err: [detail(`${argv.value[0]}: ${exit.stderr}`)] };
  if (exit.code === 0) return { ...goOn, err: lines(exit.stderr).map(aside) };
  return { failed: true, stopped: true, why: `exit ${String(exit.code)}`, out: [], err: lines(exit.stderr).map(detail) };
};

const perform = async (step: Step, io: Io): Promise<Outcome> => {
  switch (step.kind) {
    case "run":
      return runStep(step);
    case "check":
      return check(step);
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
