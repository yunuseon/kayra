import type { Part, Plan, Step } from "../plan.ts";
import { commandOf, kindOf, titleOf } from "../plan.ts";
import { active, bad, muted, ok, strong, warn, type Line } from "./line.ts";
import { duration } from "./text.ts";

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
