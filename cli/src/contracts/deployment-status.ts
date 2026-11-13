import { z } from "zod";
import { names } from "../lib/names.ts";
import { err, ok } from "../lib/result.ts";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const targetShape = z.object({ plan: digest, commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict();
const target = targetShape.readonly();
const verified = targetShape.extend({ verifiedAt: z.number().int().positive() }).strict().readonly();
const operation = z.object({
  request: z.uuid(), phase: z.enum(["prepared", "admitted", "applying", "verifying", "recovering", "held", "succeeded", "failed", "cancelled"]),
  reason: z.enum(["deadline", "admission", "runtime", "routed", "cancelled"]).nullable(),
  cancelRequestedAt: z.number().int().positive().nullable().default(null),
  updateDeadline: z.number().int().positive(), recoveryDeadline: z.number().int().positive().nullable(),
  recovery: z.enum(["automatic-rollback", "previous-preserved", "compensated", "removed-unverified", "unstarted"]).nullable(),
}).strict().readonly();
const preparation = z.object({ request: z.uuid(), phase: z.enum(["prepared", "admitted", "migrating", "ready-for-http", "held", "cancelling", "cancelled", "failed"]),
  reason: z.enum(["deadline", "migration", "cancelled"]).nullable(), admissionDeadline: z.number().int().positive(), deadline: z.number().int().positive(),
  migrationDeadline: z.number().int().positive(), httpDeadline: z.number().int().positive().nullable(),
  completedAt: z.number().int().positive().nullable().default(null),
  cancelRequestedAt: z.number().int().positive().nullable().default(null),
  recovery: z.enum(["previous-preserved", "no-active-release"]).nullable().default(null),
  migrationOutcomes: z.array(z.object({ step: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/), outcome: z.enum(["applied", "not-applied", "unstarted"]) }).strict().readonly()).max(128).readonly().default(Object.freeze([])),
  resolution: z.object({ id: digest, outcome: z.enum(["applied", "not-applied"]), at: z.number().int().positive() }).strict().readonly().nullable().default(null),
  step: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/).nullable(),
}).strict().readonly();
const schema = z.object({
  version: z.literal(1), app: z.string().regex(names.app.pattern), incarnation: z.uuid(), runtime: z.enum(["compose", "swarm"]),
  lifecycle: z.enum(["registering", "registered", "removal-requested", "removing", "removed", "purging", "purged"]),
  verification: z.enum(["legacy-unverified", "unverified", "verified"]),
  requested: target.nullable(), desired: target.nullable(), verifiedActive: verified.nullable(), lastKnownGood: verified.nullable(),
  operation: operation.nullable(), requiredAction: z.enum(["none", "inspect-and-resolve"]),
  preparation: preparation.nullable().default(null),
  // A certified release is historical evidence, not a fresh runtime health observation.
  runtimeObservation: z.literal("not-observed"),
}).strict().readonly().superRefine((value, context) => {
  if ((value.runtime === "compose" && (value.verification !== "legacy-unverified" || value.requested !== null || value.desired !== null || value.verifiedActive !== null || value.lastKnownGood !== null || value.operation !== null || value.preparation !== null)) ||
    (value.runtime === "swarm" && value.verification !== (value.verifiedActive === null ? "unverified" : "verified")) ||
    (value.operation?.phase === "cancelled" && value.operation.cancelRequestedAt === null) ||
    (value.operation?.cancelRequestedAt !== undefined && value.operation.cancelRequestedAt !== null && !["recovering", "held", "cancelled"].includes(value.operation.phase)) ||
    value.requiredAction !== (value.operation?.phase === "held" || value.preparation?.phase === "held" ? "inspect-and-resolve" : "none") ||
    value.preparation !== null && (value.operation !== null || value.requested === null ||
      value.preparation.completedAt === null && JSON.stringify(value.requested) !== JSON.stringify(value.desired) ||
      (value.preparation.phase === "cancelled" || value.preparation.phase === "failed") !== (value.preparation.completedAt !== null) ||
      (value.preparation.phase === "held" || value.preparation.phase === "cancelled" || value.preparation.phase === "failed") !== (value.preparation.reason !== null) ||
      value.preparation.phase === "cancelled" && value.preparation.reason !== "cancelled" ||
      value.preparation.phase === "failed" && value.preparation.reason !== "deadline" && value.preparation.reason !== "migration" ||
      value.preparation.completedAt !== null && (value.preparation.step !== null && value.preparation.resolution === null && value.preparation.phase !== "cancelled" || value.desired?.plan !== value.verifiedActive?.plan || value.desired?.commit !== value.verifiedActive?.commit) ||
      value.preparation.phase === "cancelling" && value.preparation.cancelRequestedAt === null ||
      value.preparation.completedAt === null && value.preparation.phase !== "cancelling" && (value.preparation.phase === "ready-for-http") !== (value.preparation.httpDeadline !== null) ||
      value.preparation.recovery !== null && (value.preparation.completedAt === null || value.preparation.recovery !== (value.verifiedActive === null ? "no-active-release" : "previous-preserved")) ||
      value.preparation.migrationOutcomes.length > 0 && value.preparation.completedAt === null ||
      new Set(value.preparation.migrationOutcomes.map((item) => item.step)).size !== value.preparation.migrationOutcomes.length ||
      value.preparation.admissionDeadline > value.preparation.migrationDeadline || value.preparation.migrationDeadline !== value.preparation.deadline - 180_000 ||
      value.preparation.httpDeadline !== null && value.preparation.httpDeadline > value.preparation.deadline - 90_000)) context.addIssue({ code: "custom", message: "inconsistent deployment projection" });
});
export type DeploymentStatus = z.infer<typeof schema>;

/** Read-only reporting format; parsing this data never grants workload authority. */
export const parseDeploymentStatus = (input: unknown) => {
  const parsed = schema.safeParse(input);
  return parsed.success ? ok<DeploymentStatus>(parsed.data) : err("invalid deployment status");
};
