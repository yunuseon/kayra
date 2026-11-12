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
  updateDeadline: z.number().int().positive(), recoveryDeadline: z.number().int().positive().nullable(),
  recovery: z.enum(["automatic-rollback", "previous-preserved", "compensated", "removed-unverified", "unstarted"]).nullable(),
}).strict().readonly();
const schema = z.object({
  version: z.literal(1), app: z.string().regex(names.app.pattern), incarnation: z.uuid(), runtime: z.enum(["compose", "swarm"]),
  lifecycle: z.enum(["registering", "registered", "removal-requested", "removing", "removed", "purging", "purged"]),
  verification: z.enum(["legacy-unverified", "unverified", "verified"]),
  requested: target.nullable(), desired: target.nullable(), verifiedActive: verified.nullable(), lastKnownGood: verified.nullable(),
  operation: operation.nullable(), requiredAction: z.enum(["none", "inspect-and-resolve"]),
  // A certified release is historical evidence, not a fresh runtime health observation.
  runtimeObservation: z.literal("not-observed"),
}).strict().readonly().superRefine((value, context) => {
  if ((value.runtime === "compose" && (value.verification !== "legacy-unverified" || value.requested !== null || value.desired !== null || value.verifiedActive !== null || value.lastKnownGood !== null || value.operation !== null)) ||
    (value.runtime === "swarm" && value.verification !== (value.verifiedActive === null ? "unverified" : "verified")) ||
    value.requiredAction !== (value.operation?.phase === "held" ? "inspect-and-resolve" : "none")) context.addIssue({ code: "custom", message: "inconsistent deployment projection" });
});
export type DeploymentStatus = z.infer<typeof schema>;

/** Read-only reporting format; parsing this data never grants workload authority. */
export const parseDeploymentStatus = (input: unknown) => {
  const parsed = schema.safeParse(input);
  return parsed.success ? ok<DeploymentStatus>(parsed.data) : err("invalid deployment status");
};
