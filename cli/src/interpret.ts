import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";
import type { Arg, Argv, Env, Plan, Probe, Step } from "./plan.ts";

/** Where the interpreter talks to the operator. */
export type Io = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly ask: (prompt: string) => Promise<string>;
};

type Exit = { readonly code: number; readonly stdout: string; readonly stderr: string };

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
    ? { code: 127, stdout: "", stderr: exit.message }
    : { code: exit, stdout: await stdout, stderr: await stderr };
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

/** Each query's answer in place of it, as `$(…)` would: one word, or split into many. Undefined if one failed. */
const resolve = async (argv: readonly [string, ...Arg[]], io: Io): Promise<Argv | undefined> => {
  const words = await Promise.all(
    argv.map(async (value) => {
      if (typeof value === "string") return [value];
      const exit = await capture(value.argv, "show", value.env);
      if (exit.code !== 0) {
        io.err(`kayra: ${value.argv.join(" ")} failed (exit ${String(exit.code)})`);
        return undefined;
      }
      const output = exit.stdout.replace(/\n+$/, "");
      return value.words === "one" ? [output] : output.split(/\s+/).filter((word) => word !== "");
    }),
  );
  const [program, ...rest] = words.flatMap((word) => word ?? []);
  return words.includes(undefined) || program === undefined ? undefined : [program, ...rest];
};

const lines = (text: string): readonly string[] =>
  text
    .trimEnd()
    .split("\n")
    .filter((line) => line !== "");

type Outcome = { readonly failed: boolean; readonly stopped: boolean };
const goOn: Outcome = { failed: false, stopped: false };

const check = async (step: Extract<Step, { kind: "check" }>, io: Io): Promise<Outcome> => {
  const exit = await answer(step.probe);
  const hint = step.hint === undefined ? [] : [`    → ${step.hint}`];
  if (step.onFailure === "stop") {
    if (exit.code === 0) return goOn;
    [...lines(exit.stderr), ...hint].forEach(io.err);
    return { failed: true, stopped: true };
  }
  if (exit.code === 0) {
    io.out(`ok    ${step.label}`);
    return goOn;
  }
  [`FAIL  ${step.label}`, ...lines(exit.stderr).map((line) => `    ${line}`), ...hint].forEach(io.out);
  return { failed: true, stopped: false };
};

const perform = async (step: Step, io: Io): Promise<Outcome> => {
  switch (step.kind) {
    case "run": {
      const argv = await resolve(step.argv, io);
      if (argv === undefined) return { failed: true, stopped: true };
      const exit = await spawned(argv, { stdout: step.stdout, stderr: "show" }, step.env);
      return exit.code === 0 ? goOn : { failed: true, stopped: true };
    }
    case "check":
      return check(step, io);
    case "confirm": {
      const typed = await io.ask(step.prompt);
      if (typed === step.expect) return goOn;
      io.out("Aborted.");
      return { failed: false, stopped: true };
    }
    case "note":
      io.out(step.text);
      return goOn;
  }
};

/** Runs a plan step by step, until it ends or a step stops it. True if nothing failed. */
export const interpret = async (plan: Plan, io: Io): Promise<boolean> => {
  const outcome = await plan.reduce<Promise<{ readonly failures: number; readonly stopped: boolean }>>(
    async (previous, step) => {
      const so = await previous;
      if (so.stopped) return so;
      const next = await perform(step, io);
      return { failures: so.failures + (next.failed ? 1 : 0), stopped: next.stopped };
    },
    Promise.resolve({ failures: 0, stopped: false }),
  );
  return outcome.failures === 0;
};
