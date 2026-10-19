import type { Part, Plan, Step } from "../plan/model.ts";
import { typed } from "../../lib/typed.ts";

/** How a step went, as far as showing it goes. */
export type Done = {
  readonly failed: boolean;
  readonly stopped: boolean;
  /** A few words on why it failed, after its time: "exit 2". */
  readonly why?: string;
};

/** Where a step is in its plan; `opens` names the part it begins, in a plan of several. */
export type At = { readonly index: number; readonly total: number; readonly opens?: Part };

/** Why a plan stopped before its end. */
export const stopReasons = ["failed", "declined", "interrupted"] as const;
export type StopReason = (typeof stopReasons)[number];

/** How a plan ended: every step run, or stopped at one. */
export type Ended = {
  readonly failures: number;
  readonly stop?: { readonly index: number; readonly step: Step; readonly why: StopReason };
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

export const parts = (plan: Plan) => typed<readonly Part[]>([...new Set(plan.flatMap((step) => (step.part === undefined ? Object.freeze([]) : Object.freeze([step.part]))))]);

/** Where the step at `index` is, for a plan that may consist of several parts. */
export const position = (plan: Plan, index: number) => {
  const part = plan[index]?.part;
  const opens = part !== undefined && parts(plan).length > 1 && plan[index - 1]?.part !== part;
  return typed<At>({ index, total: plan.length, ...(opens ? { opens: part } : {}) });
};
