import type { Plan, Step } from "../plan/model.ts";
import { active, bad, ok as fine, muted, strong, type Line, type Text } from "../text/spans.ts";
import { position, silent, type Done, type Ended, type Progress } from "./progress.ts";
import { draw } from "../present/views.ts";
import { ask, isStopped, type Io } from "./io.ts";
import { answer, resolve, spawned, type Plumbing } from "./process.ts";
import { meet, scratch, type Given, type Met } from "./needs.ts";
import { inPty } from "./pty.ts";

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

type Running = Ended & { readonly asked: Given };

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
