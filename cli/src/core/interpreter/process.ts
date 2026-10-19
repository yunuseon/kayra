import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";
import type { Arg, Argv, Env, Probe } from "../plan/model.ts";
import { all, err, flatMap, ok, type Result } from "../../result.ts";
import { isStopped, type Io } from "./io.ts";
import { exitCode, type ExitCode } from "../fleet/brand.ts";

/** Where a program's streams go: kayra's terminal, or the sink and signal of an Io without one. */
export type Plumbing = Pick<Io, "output" | "signal">;

const terminal: Plumbing = {};

/** A program that ignores SIGINT this long gets SIGTERM. */
const patience = 10_000;

/** `started` is false if the program could not be run at all; `stderr` then says why. */
type Exit = { readonly code: ExitCode; readonly stdout: string; readonly stderr: string; readonly started: boolean };

/**
 * What a program reads: kayra's terminal, nothing, a line kayra gives it (a
 * password), or what the operator types as it comes.
 */
export type Stdin =
  | { readonly kind: "inherit" }
  | { readonly kind: "none" }
  | { readonly kind: "given"; readonly text: string }
  | { readonly kind: "typed"; readonly input: NonNullable<Io["input"]> };

type Wiring = { readonly stdout: "show" | "capture" | "discard"; readonly stderr: "show" | "capture"; readonly stdin?: Stdin };

export const spawned = async (argv: Argv, streams: Wiring, env: Env = {}, plumbing: Plumbing = terminal): Promise<Exit> => {
  const [program, ...args] = argv;
  const { output, signal } = plumbing;
  if (isStopped(signal)) return { code: exitCode(130), stdout: "", stderr: "", started: false };
  const shown = (stream: "show" | "capture" | "discard"): "inherit" | "pipe" | "ignore" =>
    stream === "show" ? (output === undefined ? "inherit" : "pipe") : stream === "capture" ? "pipe" : "ignore";
  const stdin = streams.stdin ?? (output === undefined ? { kind: "inherit" } : { kind: "none" });
  const child = spawn(program, args, {
    env: { ...process.env, ...env },
    detached: output !== undefined,
    stdio: [stdin.kind === "inherit" ? "inherit" : stdin.kind === "none" ? "ignore" : "pipe", shown(streams.stdout), shown(streams.stderr)],
  });
  const forward = (from: "stdout" | "stderr", sink: (chunk: string, stream: "stdout" | "stderr") => void): void => {
    child[from]?.setEncoding("utf8").on("data", (chunk: string) => {
      sink(chunk, from);
    });
  };
  if (output !== undefined && streams.stdout === "show") forward("stdout", output);
  if (output !== undefined && streams.stderr === "show") forward("stderr", output);
  // A program that exits before reading all it was given must not take kayra down with EPIPE.
  child.stdin?.on("error", () => undefined);
  if (stdin.kind === "given") child.stdin?.end(stdin.text);
  const unsubscribe =
    stdin.kind === "typed"
      ? stdin.input((chunk) => {
          child.stdin?.write(chunk);
        })
      : () => undefined;
  const read = (from: "stdout" | "stderr", stream: "show" | "capture" | "discard"): Promise<string> => {
    const piped = child[from];
    return piped === null || stream !== "capture" ? Promise.resolve("") : text(piped);
  };
  const stdout = read("stdout", streams.stdout);
  const stderr = read("stderr", streams.stderr);
  const kill = (withSignal: "SIGINT" | "SIGTERM"): void => {
    if (child.pid === undefined) return;
    try {
      if (output === undefined) child.kill(withSignal);
      else process.kill(-child.pid, withSignal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  // eslint-disable-next-line functional/prefer-immutable-types -- the escalation belongs to this child, cleared when it exits
  const stopping: { timer?: ReturnType<typeof setTimeout> } = {};
  const stop = (): void => {
    if (stopping.timer !== undefined) return;
    if (stdin.kind === "typed") child.stdin?.write("\u0003");
    kill("SIGINT");
    // eslint-disable-next-line functional/immutable-data -- see above
    stopping.timer = setTimeout(() => { kill("SIGTERM"); }, patience);
    stopping.timer.unref();
  };
  // The process group exists only once Node confirms the child has spawned.
  child.once("spawn", () => {
    signal?.addEventListener("abort", stop, { once: true });
    if (isStopped(signal)) stop();
  });
  const exit = await new Promise<number | Error>((resolve) => {
    child.on("error", resolve);
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
  signal?.removeEventListener("abort", stop);
  clearTimeout(stopping.timer);
  unsubscribe();
  return exit instanceof Error
    ? { code: exitCode(127), stdout: "", stderr: exit.message, started: false }
    : { code: exitCode(exit), stdout: await stdout, stderr: await stderr, started: true };
};

/** A command's stdout, for kayra to read; its stderr reaches the operator unless captured too. */
export const capture = (argv: Argv, stderr: "show" | "capture" = "show", env: Env = {}, plumbing: Plumbing = terminal): Promise<Exit> =>
  spawned(argv, { stdout: "capture", stderr }, env, plumbing);

export const answer = (probe: Probe, plumbing: Plumbing): Promise<Exit> =>
  spawned(
    probe.kind === "on-path" ? ["sh", "-c", 'command -v "$1"', "sh", probe.program] : probe.argv,
    { stdout: "discard", stderr: "capture", stdin: { kind: "none" } },
    probe.kind === "exits-zero" ? probe.env : {},
    plumbing,
  );

/** Each query's answer in place of it, as `$(…)` would: one word, or split into many. */
export const resolve = async (argv: readonly [string, ...Arg[]], plumbing: Plumbing): Promise<Result<Argv, string>> => {
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
