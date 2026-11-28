import { createHash } from "node:crypto";
import { z } from "zod";
import { err, ok } from "../lib/result.ts";
import type { MigrationProbe } from "./migration-probe.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(65536).refine((value) => !value.includes("\0"));
const key = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const word = text.max(4096);
const scope = z.object({ app: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), incarnation: z.uuid(), run: z.uuid(),
  step: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/), purpose: z.enum(["migration", "probe"]), attempt: positive.max(8),
}).strict().readonly();
const shape = z.object({ version: z.literal(1), scope,
  image: z.string(), command: z.array(word).min(1).max(128).refine((value) => value[0] !== "").readonly(),
  entrypoint: z.array(word).min(1).max(128).refine((value) => value[0] !== "").readonly().nullable(),
  environment: z.record(key, z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("literal"), value: text }).strict().readonly(),
    z.object({ kind: z.literal("configuration"), key }).strict().readonly(),
    z.object({ kind: z.literal("secret"), key }).strict().readonly(),
  ])).readonly(),
  resources: z.object({ memoryBytes: positive, nanoCpus: positive }).strict().readonly(),
  networks: z.array(z.string().regex(/^[a-z0-9]{25}$/)).max(2).readonly(),
  deadline: positive, stopGraceSeconds: positive.max(30),
  startDeadline: positive.optional(), executionTimeoutSeconds: positive.max(86400).optional(),
}).strict();
const schema = shape.readonly();
const template = shape.omit({ scope: true, command: true, deadline: true, startDeadline: true, executionTimeoutSeconds: true }).readonly();
export type JobScope = z.infer<typeof scope>;
export type JobPlan = z.infer<typeof schema>;
export type JobTemplate = z.infer<typeof template>;
export type JobWrite = "acknowledged" | "uncertain" | "conflict" | "refused";
export type JobObservation =
  | { readonly status: "absent" | "foreign" | "unavailable" }
  | { readonly status: "owned"; readonly id: string; readonly barrier: boolean; readonly plan: string;
      readonly state: "created" | "running" | "succeeded" | "failed" | "unknown"; readonly exitCode: number | null;
      readonly probe: MigrationProbe["outcome"] | null; readonly finishedAt: number | null };
export type JobPort = {
  readonly observe: (plan: JobPlan) => Promise<JobObservation>;
  readonly create: (plan: JobPlan, environment: Readonly<Record<string, string>>) => Promise<JobWrite>;
  /** Exactly one dispatch per durable start intent. An uncertain start must be observed/fenced, never replayed. */
  readonly start: (plan: JobPlan, id: string, executionDeadline?: number) => Promise<JobWrite>;
  /** Deletes only the recorded ID, then reserves the stable name with an inert, never-started barrier. */
  readonly fence: (plan: JobPlan, id: string | null, deadline: number) => Promise<JobWrite>;
};

export const parseJobScope = (input: unknown) => {
  const parsed = scope.safeParse(input);
  return parsed.success ? ok<JobScope>(parsed.data) : err("invalid one-shot identity");
};
export const parseJobPlan = (input: unknown) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err("invalid one-shot plan");
  const plan = parsed.data;
  const component = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
  if (!new RegExp(`^localhost:5000/${plan.scope.app}/${component}(?:/${component})*@sha256:[0-9a-f]{64}$`).test(plan.image) ||
    (plan.startDeadline !== undefined && plan.startDeadline > plan.deadline) ||
    new Set(plan.networks).size !== plan.networks.length || Object.keys(plan.environment).includes("KAYRA_OPERATION_ID")) return err("invalid one-shot image, networks or reserved environment");
  return ok<JobPlan>(plan);
};

/** Description only. Scope, command and deadlines are supplied by the owning operation. */
export const parseJobTemplate = (input: unknown, app: string) => {
  const parsed = template.safeParse(input); if (!parsed.success) return err("invalid one-shot template");
  const checked = parseJobPlan({ ...parsed.data, command: ["/validation-only"], deadline: 1,
    scope: { app, incarnation: "00000000-0000-4000-8000-000000000000", run: "00000000-0000-4000-8000-000000000001", step: "template", purpose: "migration", attempt: 1 } });
  return checked.ok ? ok<JobTemplate>(parsed.data) : err("invalid one-shot template");
};

/** Runtime names bind the entire stable identity, including purpose and attempt. */
export const jobName = (input: JobScope) => {
  const parsed = parseJobScope(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return "kayra-job-" + createHash("sha256").update(JSON.stringify(parsed.value)).digest("hex").slice(0, 48);
};
export const jobPlanDigest = (input: JobPlan) => {
  const parsed = parseJobPlan(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return createHash("sha256").update(JSON.stringify(parsed.value)).digest("hex");
};
