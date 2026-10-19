import type { Part, Plan } from "../plan/model.ts";
import { commandOf, kindOf, titleOf } from "../plan/describe.ts";
import { bad, muted, ok, pointing, strong, warn, type Line } from "../text/spans.ts";
import { duration } from "../text/time.ts";
import { parts, position, type Ended, type Progress, type StopReason } from "./progress.ts";
import { count } from "../text/plural.ts";
import type { Server } from "../fleet/model.ts";

/** The invocation, as the heading and the footer name it. */
export type Heading = {
  /** `kayra deploy alaz`, as typed. */
  readonly command: string;
  /** The server it runs on, if one: the footer's hint names it. */
  readonly server?: string;
  /** What else the heading says, after the command. */
  readonly about: readonly string[];
};

/** The heading for a command: as typed, what it runs on, which kayra. */
export const heading = (command: string, target: Server | undefined, version: string): Heading => ({
  command,
  ...(target === undefined ? {} : { server: target.name }),
  about: [...(target === undefined ? [] : [`${target.kind} on ${target.target}`, target.domain]), `kayra ${version}`],
});

/** "8 steps", or "15 checks" for a plan of nothing else (doctor). */
export const steps = (plan: Plan): string => {
  const noun = plan.every((step) => step.kind === "check") ? "check" : "step";
  return count(plan.length, noun);
};

/** The footer: how it went, how long it took, and what reruns a failed part alone. */
export const footer = (invocation: Heading, plan: Plan, ended: Ended, ms: number): readonly Line[] => {
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
    ...(alone ? [pointing("  ", strong(`kayra ${part} ${invocation.server ?? ""}`), muted(" runs just this part"))] : []),
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
  | { readonly kind: "plan"; readonly invocation: Heading; readonly steps: readonly Listed[] }
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
      readonly stop?: { readonly index: number; readonly why: StopReason };
      readonly ms: number;
      readonly footer: readonly Line[];
    };

/** The plan and each step as events: what framed draws on a terminal, as data. */
export const reporting = (emit: (event: Event) => void, invocation: Heading, short: (text: string) => string): Progress => ({
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
