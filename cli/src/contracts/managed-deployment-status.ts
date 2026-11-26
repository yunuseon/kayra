import { z } from "zod";
import { err, ok } from "../lib/result.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const target = z.object({ plan: digest, commit: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
const verified = target.extend({ run: z.uuid(), verifiedAt: time, compatibilityEpoch: epoch }).strict().readonly();
const schema = z.object({
  version: z.literal(3), protocol: z.literal("managed-v3"), runtime: z.literal("swarm"),
  app: z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), incarnation: z.uuid(),
  requested: target.readonly(), desired: target.readonly().nullable(), verifiedActive: verified.nullable(), lastKnownGood: verified.nullable(),
  previousRelease: z.object({ record: digest, commit: target.shape.commit, run: z.uuid(), verifiedAt: time }).strict().readonly().exactOptional(),
  forwardRecovery: z.object({ request: z.uuid(), phase: z.enum(["initializing", "fencing", "transferring", "held"]), deadline: time }).strict().readonly().exactOptional(),
  compatibilityEpoch: epoch, rollback: z.enum(["eligible", "no-previous-release", "application-incompatible", "data-fenced"]),
  operation: z.object({ run: z.uuid(), strategy: z.enum(["rolling", "maintenance"]),
    phase: z.enum(["admitting", "allocating", "quiescing", "preparing", "updating", "verifying", "recovering", "recovery-verifying", "settling", "complete", "held"]),
    reason: z.enum(["admission", "allocation", "deadline", "authorization", "quiescence", "preparation", "consumers", "verification", "recovery", "recovery-verification", "cancellation"]).nullable(),
    outcome: z.enum(["deployed", "rolled-back", "absent", "unchanged"]).nullable(),
    admissionDeadline: time, deadline: time, recoveryDeadline: time.nullable(), cancelRequestedAt: time.nullable(),
    admitted: z.boolean(), settled: z.boolean(),
  }).strict().readonly(),
  migrations: z.object({ phase: z.enum(["not-started", "running", "held", "succeeded"]),
    reason: z.enum(["deadline", "runtime", "unsafe-outcome", "probe-unknown", "not-applied", "attempts-exhausted", "cancelled"]).nullable(),
    step: z.string().max(128).nullable(),
    resolutions: z.array(z.object({ step: z.string().max(128), id: digest, outcome: z.enum(["applied", "not-applied"]), at: time }).strict().readonly()).max(128).readonly(),
  }).strict().readonly(),
  recovery: z.object({ phase: z.enum(["fencing-checks", "restoring", "checking-restored", "complete", "held"]),
    reason: z.enum(["deadline", "runtime", "authorization", "verification"]).nullable(), deadline: time,
    checks: z.object({ containers: z.number().int().min(0).max(128), stopped: z.number().int().min(0).max(128) }).strict().readonly(),
  }).strict().readonly().nullable().default(null),
  requiredAction: z.enum(["none", "inspect-and-resolve"]), runtimeObservation: z.literal("not-observed"),
}).strict().readonly().superRefine((value, context) => {
  const recovery = value.recovery;
  if (recovery !== null && (recovery.deadline !== value.operation.recoveryDeadline || recovery.checks.stopped > recovery.checks.containers ||
    (recovery.phase === "held") !== (recovery.reason !== null) || (recovery.phase === "held") !== (value.operation.phase === "held") ||
    !["fencing-checks", "held"].includes(recovery.phase) && recovery.checks.stopped !== recovery.checks.containers ||
    ["fencing-checks", "restoring"].includes(recovery.phase) && value.operation.phase !== "recovering" ||
    (recovery.phase === "complete") !== (value.operation.outcome === "rolled-back" || value.operation.outcome === "absent") ||
    recovery.phase === "checking-restored" && !["recovering", "recovery-verifying"].includes(value.operation.phase))) context.addIssue({ code: "custom", message: "inconsistent managed recovery progress" });
  if (value.forwardRecovery !== undefined && (value.operation.phase !== "held" || value.forwardRecovery.request === value.operation.run) ||
    value.previousRelease !== undefined && (value.operation.phase !== "complete" || value.verifiedActive === null || value.previousRelease.verifiedAt > value.verifiedActive.verifiedAt || value.previousRelease.run === value.verifiedActive.run) ||
    value.requiredAction !== (value.operation.phase === "held" ? "inspect-and-resolve" : "none") ||
    (value.operation.phase === "held") !== (value.operation.reason !== null) ||
    value.operation.settled !== (value.operation.phase === "complete") ||
    (value.operation.outcome !== null) !== ["settling", "complete"].includes(value.operation.phase) ||
    value.operation.admissionDeadline >= value.operation.deadline || value.operation.recoveryDeadline !== null && value.operation.recoveryDeadline > value.operation.deadline ||
    [value.verifiedActive, value.lastKnownGood].some((item) => item !== null && item.compatibilityEpoch > value.compatibilityEpoch)) context.addIssue({ code: "custom", message: "inconsistent managed deployment status" });
});

export type ManagedDeploymentStatus = z.infer<typeof schema>;
/** Published reporting data. This contract contains no runtime authority or private journal layout. */
export const parseManagedDeploymentStatus = (input: unknown) => {
  const result = schema.safeParse(input);
  return result.success ? ok<ManagedDeploymentStatus>(result.data) : err("invalid managed deployment status");
};
export const managedDeploymentStatusSchema = schema;
