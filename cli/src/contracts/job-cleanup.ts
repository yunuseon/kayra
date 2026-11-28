import { z } from "zod";
import { err, ok } from "../lib/result.ts";
import type { JobObservation, JobPlan, JobWrite } from "./one-shot-job.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({ version: z.literal(1), action: z.uuid(), job: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: positive, deadline: positive,
}).strict().readonly().refine((value) => value.deadline === value.createdAt + 30_000);
export type JobCleanupPlan = z.infer<typeof schema>;
export type JobCleanupPort = {
  readonly observe: (job: JobPlan) => Promise<JobObservation>;
  /** Separate cleanup authority cannot Create/Start an application command or materialize its environment. */
  readonly fence: (job: JobPlan, cleanup: JobCleanupPlan, container: string | null) => Promise<JobWrite>;
};

/** An explicit recovery action grants at most thirty seconds; it never alters the job's deadlines. */
export const parseJobCleanupPlan = (input: unknown) => {
  const parsed = schema.safeParse(input);
  return parsed.success ? ok<JobCleanupPlan>(parsed.data) : err("invalid bounded job cleanup authority");
};

const id = z.string().regex(/^[0-9a-f]{64}$/);
const shape = z.object({ version: z.literal(1), authority: z.unknown(), phase: z.enum(["fencing", "complete", "held"]),
  targets: z.array(id).max(8).readonly(), barrier: id.nullable(), completedAt: z.number().int().positive().nullable(),
}).strict().readonly();
export const parseJobCleanupState = (input: unknown) => {
  const parsed = shape.safeParse(input); if (!parsed.success) throw new Error("invalid job cleanup state");
  const state = parsed.data; const authority = parseJobCleanupPlan(state.authority);
  if (!authority.ok || new Set(state.targets).size !== state.targets.length || (state.phase === "complete") !== (state.barrier !== null) ||
    (state.phase === "complete") !== (state.completedAt !== null) || state.barrier !== null && state.targets.includes(state.barrier) ||
    state.completedAt !== null && (state.completedAt < authority.value.createdAt || state.completedAt >= authority.value.deadline)) throw new Error("inconsistent job cleanup proof");
  return Object.freeze({ ...state, authority: authority.value });
};
export type JobCleanupState = ReturnType<typeof parseJobCleanupState>;
