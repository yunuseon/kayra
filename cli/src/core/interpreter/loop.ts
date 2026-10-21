import type { Plan, Step } from "../plan/model.ts";
import { bad, ok as fine, muted, pointing, strong, type Line, type Text } from "../text/spans.ts";
import { position, silent, type Done, type Ended, type Progress } from "./progress.ts";
import { ask, isStopped, type Io } from "./io.ts";
import { answer, resolve, spawned, type Plumbing } from "./process.ts";
import { meet, scratch, type Given, type Met } from "./needs.ts";
import { inPty } from "./pty.ts";
import { typed } from "../../lib/typed.ts";

/** Lines as printing them one by one gives the text back: newline-ended, as a ctl writes. */
const asItCame = (_answer: unknown, said: string) => (said === "" ? typed<readonly string[]>([]) : said.replace(/\n$/, "").split("\n"));

const lines = (text: string) =>
  Object.freeze(text
    .trimEnd()
    .split("\n")
    .filter((line) => line !== ""));

/** Under the step's own line. */
const detail = (line: string) => typed<Line>(["    ", line]);

const aside = (line: string) => typed<Line>(["    ", muted(line)]);

const hint = (text: string | undefined) => (typed<readonly Line[]>(text === undefined ? [] : [pointing("    ", text)]));

/** How a step went, and what it has to say: printed once its spinner is gone. */
type Outcome = Done & { readonly out: readonly Text[]; readonly err: readonly Text[] };

const goOn: Outcome = { failed: false, stopped: false, out: [], err: [] };

const check = async (step: Extract<Step, { kind: "check" }>, plumbing: Plumbing) => {
  const exit = await answer(step.probe, plumbing);
  const said = [...lines(exit.stderr).map(detail), ...hint(step.hint)];
  if (step.onFailure === "stop") return exit.code === 0 ? goOn : typed<Outcome>({ failed: true, stopped: true, out: [], err: said });
  return typed<Outcome>(exit.code === 0 ? { ...goOn, out: [[fine("✓"), " ", step.label]] } : { failed: true, stopped: false, out: [[bad("✗"), " ", step.label], ...said], err: [] });
};

const runStep = async (step: Extract<Step, { kind: "run" | "session" }>, io: Io, met: Met) => {
  const argv = await resolve(step.argv, io, met.env);
  if (!argv.ok) return typed<Outcome>({ failed: true, stopped: true, why: "a query failed", out: [], err: [detail(argv.error)] });
  const { stdout } = step;
  const talks = step.kind === "session" && io.output !== undefined;
  if (talks && io.input === undefined) return typed<Outcome>({ failed: true, stopped: true, why: "no terminal", out: [], err: [detail("it talks with a person, and this client gives it no keys")] });
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
  if (!exit.started) return typed<Outcome>({ failed: true, stopped: true, why: "not started", out: [], err: [detail(`${argv.value[0]}: ${exit.stderr}`)] });
  // Whatever it answered is shown, even when it failed: it may say why.
  const out = typeof stdout === "string" ? [] : (io.draw ?? asItCame)(stdout, exit.stdout);
  if (exit.code === 0) return typed<Outcome>({ ...goOn, out, err: lines(exit.stderr).map(aside) });
  return typed<Outcome>({ failed: true, stopped: true, why: `exit ${String(exit.code)}`, out, err: lines(exit.stderr).map(detail) });
};

const perform = async (step: Step, io: Io, met: Met) => {
  switch (step.kind) {
    case "session":
    case "run":
      return runStep(step, io, met);
    case "check":
      return check(step, io);
    case "confirm": {
      io.err("");
      io.err(["  ", bad("▲"), " ", strong(step.warning)]);
      const answered = await ask(io, { kind: "confirm", text: ["    Type ", strong(step.expect), " to confirm: "], expect: step.expect });
      return answered === step.expect ? goOn : typed<Outcome>({ failed: false, stopped: true, out: ["Aborted."], err: [] });
    }
    case "note":
      return typed<Outcome>({ ...goOn, out: [step.text] });
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
) => {
  const made = scratch();
  try {
    const ended = await progress.plan(plan, () =>
      plan.reduce<Promise<Running>>(async (previous, step, index) => {
        const so = await previous;
        if (so.stop !== undefined) return so;
        if (interrupted() || isStopped(io.signal)) return { ...so, stop: { index, step, why: "interrupted" } };
        // What a step needs is asked before its frame opens: a prompt, then the step.
        const meeting = (step.kind === "run" || step.kind === "session") && step.needs !== undefined ? await meet(step.needs, so.asked, io, made) : { kind: "met", meeting: { met: { env: {} }, given: so.asked } } as const;
        if (meeting.kind === "declined") {
          io.err(["    ", muted("Nothing given: stopped before it ran.")]);
          return { ...so, stop: { index, step, why: isStopped(io.signal) ? "interrupted" : "declined" } };
        }
        if (meeting.kind === "failed") {
          io.err(["    ", muted(meeting.why)]);
          return { failures: so.failures + 1, asked: so.asked, stop: { index, step, why: isStopped(io.signal) ? "interrupted" : "failed" } };
        }
        const met = { met: meeting.meeting.met, asked: meeting.meeting.given };
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
