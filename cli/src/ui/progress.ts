import type { Part, Plan, Step } from "../plan.ts";
import { commandOf, kindOf, titleOf } from "../plan.ts";
import { accent, active, bad, muted, ok, paint, strong, warn, type Line, type Text } from "./line.ts";
import { escapes, spinner, type Screen } from "./terminal.ts";
import { duration, spread, truncate } from "./text.ts";

/** How a step went, as far as showing it goes. */
export type Done = {
  readonly failed: boolean;
  readonly stopped: boolean;
  /** A few words on why it failed, after its time: "exit 2". */
  readonly why?: string;
};

/** Where a step is in its plan; `opens` names the part it begins, in a plan of several. */
export type At = { readonly index: number; readonly total: number; readonly opens?: Part };

/** How a plan ended: every step run, or stopped at one. */
export type Ended = {
  readonly failures: number;
  readonly stop?: { readonly index: number; readonly step: Step; readonly why: "failed" | "declined" | "interrupted" };
};

/** What the operator sees of a plan while it runs: brackets around the plan and around each step. */
export type Progress = {
  readonly plan: (plan: Plan, work: () => Promise<Ended>) => Promise<Ended>;
  readonly step: <T extends Done>(step: Step, at: At, work: () => Promise<T>) => Promise<T>;
};

/** Nothing around the steps: for commands whose output is the point (ssh, logs), and for tests. */
export const silent: Progress = {
  plan: (_plan, work) => work(),
  step: (_step, _at, work) => work(),
};

const parts = (plan: Plan): readonly Part[] => [...new Set(plan.flatMap((step) => (step.part === undefined ? [] : [step.part])))];

/** Where the step at `index` is, for a plan that may consist of several parts. */
export const position = (plan: Plan, index: number): At => {
  const part = plan[index]?.part;
  const opens = part !== undefined && parts(plan).length > 1 && plan[index - 1]?.part !== part;
  return { index, total: plan.length, ...(opens ? { opens: part } : {}) };
};

/** The invocation, as the heading and the footer name it. */
export type Invocation = {
  /** `kayra deploy alaz`, as typed. */
  readonly command: string;
  /** The server it runs on, if one: the footer's hint names it. */
  readonly server?: string;
  /** What else the heading says, after the command. */
  readonly about: readonly string[];
};

/** A run of this long earns a notification when it ends: the operator has looked away. */
const worthNotifying = 30_000;

/** "8 steps", or "15 checks" for a plan of nothing else (doctor). */
export const steps = (plan: Plan): string => {
  const noun = plan.every((step) => step.kind === "check") ? "check" : "step";
  return `${String(plan.length)} ${noun}${plan.length === 1 ? "" : "s"}`;
};

/** The footer: how it went, how long it took, and what reruns a failed part alone. */
export const footer = (invocation: Invocation, plan: Plan, ended: Ended, ms: number): readonly Line[] => {
  const took = duration(ms);
  const { command } = invocation;
  const { stop } = ended;
  if (stop === undefined)
    return ended.failures === 0
      ? [[ok("✓"), " ", strong(command), muted(` · ${steps(plan)} · ${took}`)]]
      : [[bad("✗"), " ", strong(command), muted(` · ${String(ended.failures)} of ${steps(plan)} failed · ${took}`)]];
  const where = `step ${String(stop.index + 1)} of ${String(plan.length)}`;
  if (stop.why === "declined") return [[warn("■"), " ", strong(command), muted(` stopped at ${where}: not confirmed`)]];
  if (stop.why === "interrupted") return [[warn("■"), " ", strong(command), muted(` interrupted at ${where} · ${took}`)]];
  const { part } = stop.step;
  const alone = part !== undefined && parts(plan).length > 1 && invocation.server !== undefined;
  return [
    [bad("✗"), " ", strong(command), " failed at ", strong(titleOf(stop.step)), muted(` · ${where} · ${took}`)],
    ...(alone ? [["  ", active("→"), " ", strong(`kayra ${part} ${invocation.server ?? ""}`), muted(" runs just this part")]] : []),
  ];
};

/** Frames on stderr: a heading, each step as it runs and how it went, a footer; on a terminal also spinners, the window title, a notification. */
export const framed = (screen: Screen, write: (raw: string) => void, invocation: Invocation): Progress => {
  const columns = Math.min(screen.columns, 80);
  const say = (text: Text): void => {
    write(`${paint(text, screen.colors)}\n`);
  };
  const tell = (raw: string, when: boolean): void => {
    if (when) write(raw);
  };
  return {
    plan: async (plan, work) => {
      const started = performance.now();
      tell(escapes.pushTitle + escapes.title(invocation.command), screen.title);
      say([strong(invocation.command), muted([...invocation.about, steps(plan)].map((each) => ` · ${each}`).join(""))]);
      say("");
      const ended = await work();
      const ms = performance.now() - started;
      say("");
      footer(invocation, plan, ended, ms).forEach(say);
      tell(escapes.popTitle, screen.title);
      tell(escapes.progressDone, screen.progressBar);
      const failed = ended.failures > 0 || ended.stop?.why === "failed";
      tell(escapes.notify(`${invocation.command} ${failed ? "failed" : "is done"} after ${duration(ms)}`), screen.notifications && ms >= worthNotifying);
      return ended;
    },
    step: async (step, at, work) => {
      if (step.kind === "confirm" || step.kind === "note") return work();
      if (at.opens !== undefined) {
        if (at.index > 0) say("");
        say([accent(at.opens)]);
      }
      const title = titleOf(step);
      const counter = `${String(at.index + 1)}/${String(at.total)}`;
      tell(escapes.title(`${invocation.command} · ${counter} ${title}`), screen.title);
      tell(escapes.progress((at.index / at.total) * 100), screen.progressBar);
      const shown = step.kind === "run" && step.stdout === "show";
      if (shown) say(spread(["  ", active("◆"), " ", strong(title)], [muted(counter)], columns));
      const stop =
        !shown && screen.live
          ? spinner(write, (frame, ms) =>
              paint(spread(truncate(["  ", active(frame), " ", title], columns - 8), [muted(duration(ms))], columns), screen.colors),
            )
          : () => undefined;
      const started = performance.now();
      const done = await work();
      stop();
      // A diagnosis reports itself on stdout: that line is doctor's output.
      if (step.kind === "check" && step.onFailure === "continue") return done;
      const took = duration(performance.now() - started);
      say(
        spread(
          ["  ", done.failed ? bad("✗") : ok("✓"), " ", title],
          [muted(done.why === undefined ? took : `${done.why} · ${took}`)],
          columns,
        ),
      );
      return done;
    },
  };
};

/** A step as listed before it runs: --dry-run's facts, as data. */
export type Listed = {
  readonly index: number;
  readonly kind: string;
  readonly title: string;
  readonly command?: string;
  readonly part?: Part;
  readonly opens?: Part;
};

/** Every step of a plan, its command's paths named by their root. */
export const listed = (plan: Plan, short: (text: string) => string): readonly Listed[] =>
  plan.map((step, index) => {
    const command = commandOf(step);
    const { opens } = position(plan, index);
    return {
      index,
      kind: kindOf(step),
      title: titleOf(step),
      ...(command === undefined ? {} : { command: short(command) }),
      ...(step.part === undefined ? {} : { part: step.part }),
      ...(opens === undefined ? {} : { opens }),
    };
  });

/** A plan's run as events, for a viewer that is not a terminal. */
export type Event =
  | { readonly kind: "plan"; readonly invocation: Invocation; readonly steps: readonly Listed[] }
  | { readonly kind: "started"; readonly index: number }
  | {
      readonly kind: "done";
      readonly index: number;
      readonly failed: boolean;
      readonly stopped: boolean;
      readonly why?: string;
      readonly ms: number;
    }
  | {
      readonly kind: "ended";
      readonly failures: number;
      readonly stop?: { readonly index: number; readonly why: "failed" | "declined" | "interrupted" };
      readonly ms: number;
      readonly footer: readonly Line[];
    };

/** The plan and each step as events: what framed draws on a terminal, as data. */
export const reporting = (emit: (event: Event) => void, invocation: Invocation, short: (text: string) => string): Progress => ({
  plan: async (plan, work) => {
    const started = performance.now();
    emit({ kind: "plan", invocation, steps: listed(plan, short) });
    const ended = await work();
    const ms = performance.now() - started;
    emit({
      kind: "ended",
      failures: ended.failures,
      ...(ended.stop === undefined ? {} : { stop: { index: ended.stop.index, why: ended.stop.why } }),
      ms,
      footer: footer(invocation, plan, ended, ms),
    });
    return ended;
  },
  step: async (_step, at, work) => {
    const started = performance.now();
    emit({ kind: "started", index: at.index });
    const done = await work();
    emit({
      kind: "done",
      index: at.index,
      failed: done.failed,
      stopped: done.stopped,
      ...(done.why === undefined ? {} : { why: done.why }),
      ms: performance.now() - started,
    });
    return done;
  },
});
