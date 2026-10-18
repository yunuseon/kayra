import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import type { Arg, Argv, Env, Need, Plan, Probe, Step } from "./plan.ts";
import { all, err, flatMap, ok, type Result } from "../result.ts";
import { active, bad, muted, ok as fine, strong, type Line, type Text } from "./present/line.ts";
import { position, silent, type Done, type Ended, type Progress } from "./present/progress.ts";
import { draw } from "./present/views.ts";

/**
 * What kayra asks the operator: to type a word that confirms (a server's
 * name before destroying it), or a password, asked hidden, kept in memory for
 * this run only and never shown, logged or recorded.
 */
export type Question =
  | { readonly kind: "confirm"; readonly text: Text; readonly expect: string }
  | { readonly kind: "secret"; readonly text: Text };

/** Where the interpreter talks to the operator. */
export type Io = {
  /** What a command reports: doctor's checks, notes. */
  readonly out: (text: Text) => void;
  /** Around it: why a step stopped the plan, what a quiet step said, a warning before a question. */
  readonly err: (text: Text) => void;
  /** The operator's answer; "" for none (Ctrl-C, no more input), which stops what needed it. */
  readonly ask: (question: Question) => Promise<string>;
  /**
   * Without a terminal (the web interface, the API): what a step shows arrives
   * here instead, and no step reads kayra's stdin. Without it, steps share
   * kayra's terminal.
   */
  readonly output?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Without a terminal: what the operator types into a step that talks with them (a shell), as it comes. */
  readonly input?: (deliver: (chunk: string) => void) => () => void;
  /** Without a terminal: the size of the operator's, for a step that talks with them. */
  readonly size?: { readonly columns: number; readonly rows: number };
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
const isStopped = (signal: Io["signal"]): boolean => signal?.aborted === true;

/** A program that ignores SIGINT this long gets SIGTERM. */
const patience = 10_000;

/** `started` is false if the program could not be run at all; `stderr` then says why. */
type Exit = { readonly code: number; readonly stdout: string; readonly stderr: string; readonly started: boolean };

/**
 * What a program reads: kayra's terminal, nothing, a line kayra gives it (a
 * password), or what the operator types as it comes.
 */
type Stdin =
  | { readonly kind: "inherit" }
  | { readonly kind: "none" }
  | { readonly kind: "given"; readonly text: string }
  | { readonly kind: "typed"; readonly input: NonNullable<Io["input"]> };

type Streams = { readonly stdout: "show" | "capture" | "discard"; readonly stderr: "show" | "capture"; readonly stdin?: Stdin };

const spawned = async (argv: Argv, streams: Streams, env: Env = {}, plumbing: Plumbing = terminal): Promise<Exit> => {
  const [program, ...args] = argv;
  const { output, signal } = plumbing;
  if (isStopped(signal)) return { code: 130, stdout: "", stderr: "", started: false };
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
  signal?.addEventListener("abort", stop, { once: true });
  if (isStopped(signal)) stop();
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
    ? { code: 127, stdout: "", stderr: exit.message, started: false }
    : { code: exit, stdout: await stdout, stderr: await stderr, started: true };
};

/** A command's stdout, for kayra to read; its stderr reaches the operator unless captured too. */
export const capture = (argv: Argv, stderr: "show" | "capture" = "show", env: Env = {}, plumbing: Plumbing = terminal): Promise<Exit> =>
  spawned(argv, { stdout: "capture", stderr }, env, plumbing);

const answer = (probe: Probe, plumbing: Plumbing): Promise<Exit> =>
  spawned(
    probe.kind === "on-path" ? ["sh", "-c", 'command -v "$1"', "sh", probe.program] : probe.argv,
    { stdout: "discard", stderr: "capture", stdin: { kind: "none" } },
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

/**
 * A step's needs, met: the vault password through Ansible's password-file
 * hook (a script printing it from the step's environment, so it never touches
 * disk), sudo's on the step's stdin where none is cached.
 */
type Met = { readonly env: Env; readonly stdin?: Stdin };

/** The answers given in this run, by need: each asked once. */
type Asked = Readonly<Record<string, string>>;

const keyOf = (need: Need): string => (need.kind === "vault" ? `vault:${need.server}` : "sudo");

const questionOf = (need: Need): Question =>
  need.kind === "vault"
    ? { kind: "secret", text: ["  ", active("?"), " ", strong(`${need.server}'s vault password`), muted(" (asked once, kept for this run): ")] }
    : { kind: "secret", text: ["  ", active("?"), " ", strong("sudo's password"), muted(" (for this step only): ")] };

/** Whether sudo would run without a password: a cached one, or none needed. */
const sudoReady = async (plumbing: Plumbing): Promise<boolean> =>
  (await spawned(["sudo", "-n", "true"], { stdout: "discard", stderr: "capture", stdin: { kind: "none" } }, {}, plumbing)).code === 0;

/** The vault password script, made once per run in a directory only this user reads. */
type Scratch = { readonly vaultScript: () => string; readonly clean: () => void };

const scratch = (): Scratch => {
  // eslint-disable-next-line functional/prefer-immutable-types -- made on first need, removed when the run ends
  const made: { dir?: string } = {};
  const dir = (): string => {
    // eslint-disable-next-line functional/immutable-data -- see above
    made.dir ??= mkdtempSync(join(tmpdir(), "kayra-"));
    return made.dir;
  };
  return {
    vaultScript: () => {
      const script = join(dir(), "vault-password");
      writeFileSync(script, '#!/bin/sh\nprintf \'%s\\n\' "$KAYRA_VAULT_PASSWORD"\n', { mode: 0o700 });
      chmodSync(script, 0o700);
      return script;
    },
    clean: () => {
      if (made.dir !== undefined) rmSync(made.dir, { recursive: true, force: true });
    },
  };
};

/** Asks what a step needs and has not been given yet in this run; undefined if the operator gave nothing. */
const meet = async (needs: readonly Need[], asked: Asked, io: Io, made: Scratch): Promise<{ readonly met: Met; readonly asked: Asked } | undefined> =>
  needs.reduce<Promise<{ readonly met: Met; readonly asked: Asked } | undefined>>(async (previous, need) => {
    const so = await previous;
    if (so === undefined) return undefined;
    if (need.kind === "sudo" && (await sudoReady(io))) return so;
    const key = keyOf(need);
    const given = so.asked[key] ?? (await ask(io, questionOf(need)));
    if (given === "") return undefined;
    const now = need.kind === "vault" ? { ...so.asked, [key]: given } : so.asked;
    return need.kind === "vault"
      ? { asked: now, met: { ...so.met, env: { ...so.met.env, ANSIBLE_VAULT_PASSWORD_FILE: made.vaultScript(), KAYRA_VAULT_PASSWORD: given } } }
      : { asked: now, met: { env: { ...so.met.env, KAYRA_SUDO_STDIN: "1" }, stdin: { kind: "given", text: `${given}\n` } } };
  }, Promise.resolve({ met: { env: {} }, asked }));

/** A step that talks with a person, given a pty: macOS's script, util-linux's elsewhere. */
const inPty = (argv: Argv, size: Io["size"]): Argv => {
  const { columns, rows } = size ?? { columns: 120, rows: 32 };
  const sized = ["sh", "-c", `stty rows ${String(rows)} cols ${String(columns)} 2>/dev/null; exec "$@"`, "sh", ...argv];
  return process.platform === "darwin"
    // BSD script accepts a pipe, but rejects Node's socket-backed stdin with ENOTSUP.
    ? ["bash", "-c", '"$@" < <(cat); code=$?; kill "$!" 2>/dev/null || :; exit "$code"', "bash", "script", "-q", "/dev/null", ...sized]
    : ["script", "-q", "-e", "-c", sized.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" "), "/dev/null"];
};

const runStep = async (step: Extract<Step, { kind: "run" | "session" }>, io: Io, met: Met): Promise<Outcome> => {
  const argv = await resolve(step.argv, io);
  if (!argv.ok) return { failed: true, stopped: true, why: "a query failed", out: [], err: [detail(argv.error)] };
  const { stdout } = step;
  const talks = step.kind === "session" && io.output !== undefined;
  if (talks && io.input === undefined) return { failed: true, stopped: true, why: "no terminal", out: [], err: [detail("it talks with a person, and this client gives it no keys")] };
  // A quiet step's stderr waits until it is done, so it cannot tear through a spinner.
  const quiet = stdout === "discard";
  const exit = await spawned(
    talks ? inPty(argv.value, io.size) : argv.value,
    {
      stdout: typeof stdout === "string" ? stdout : "capture",
      stderr: quiet ? "capture" : "show",
      ...(talks && io.input !== undefined ? { stdin: { kind: "typed", input: io.input } } : met.stdin === undefined ? {} : { stdin: met.stdin }),
    },
    { ...step.env, ...met.env },
    io,
  );
  if (!exit.started) return { failed: true, stopped: true, why: "not started", out: [], err: [detail(`${argv.value[0]}: ${exit.stderr}`)] };
  // Whatever it answered is shown, even when it failed: it may say why.
  const out = typeof stdout === "string" ? [] : draw(stdout, exit.stdout, Date.now());
  if (exit.code === 0) return { ...goOn, out, err: lines(exit.stderr).map(aside) };
  return { failed: true, stopped: true, why: `exit ${String(exit.code)}`, out, err: lines(exit.stderr).map(detail) };
};

const perform = async (step: Step, io: Io, met: Met): Promise<Outcome> => {
  switch (step.kind) {
    case "session":
    case "run":
      return runStep(step, io, met);
    case "check":
      return check(step, io);
    case "confirm": {
      io.err("");
      io.err(["  ", bad("▲"), " ", strong(step.warning)]);
      const typed = await ask(io, { kind: "confirm", text: ["    Type ", strong(step.expect), " to confirm: "], expect: step.expect });
      return typed === step.expect ? goOn : { failed: false, stopped: true, out: ["Aborted."], err: [] };
    }
    case "note":
      return { ...goOn, out: [step.text] };
  }
};

/** Cancellation also ends a question; a late answer cannot restart the plan. */
const ask = async (io: Io, question: Question): Promise<string> => {
  if (isStopped(io.signal)) return "";
  return new Promise((resolve, reject) => {
    const done = (answer: string): void => {
      io.signal?.removeEventListener("abort", stopped);
      resolve(answer);
    };
    const stopped = (): void => { done(""); };
    io.signal?.addEventListener("abort", stopped, { once: true });
    void io.ask(question).then(done, (error: unknown) => {
      io.signal?.removeEventListener("abort", stopped);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
};

type Running = Ended & { readonly asked: Asked };

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
  const made = scratch();
  try {
    const ended = await progress.plan(plan, () =>
      plan.reduce<Promise<Running>>(async (previous, step, index) => {
        const so = await previous;
        if (so.stop !== undefined) return so;
        if (interrupted() || isStopped(io.signal)) return { ...so, stop: { index, step, why: "interrupted" } };
        // What a step needs is asked before its frame opens: a prompt, then the step.
        const met = (step.kind === "run" || step.kind === "session") && step.needs !== undefined ? await meet(step.needs, so.asked, io, made) : { met: { env: {} }, asked: so.asked };
        if (met === undefined) {
          io.err(["    ", muted("Nothing given: stopped before it ran.")]);
          return { ...so, stop: { index, step, why: isStopped(io.signal) ? "interrupted" : "declined" } };
        }
        const done = await progress.step(step, position(plan, index), () => perform(step, io, met.met));
        // Ctrl-C reached the step's program too: how it ended says nothing about the server.
        if (interrupted() || isStopped(io.signal)) return { failures: so.failures, asked: met.asked, stop: { index, step, why: "interrupted" } };
        done.out.forEach(io.out);
        done.err.forEach(io.err);
        const failures = so.failures + (done.failed ? 1 : 0);
        if (done.stopped) return { failures, asked: met.asked, stop: { index, step, why: done.failed ? "failed" : "declined" } };
        return { failures, asked: met.asked };
      }, Promise.resolve({ failures: 0, asked: {} })),
    );
    return ended.failures === 0 && ended.stop?.why !== "interrupted";
  } finally {
    made.clean();
  }
};
