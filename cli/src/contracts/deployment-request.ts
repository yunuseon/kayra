import { z } from "zod";
import { names } from "../lib/names.ts";
import { err, ok } from "../lib/result.ts";

const app = z.string().regex(names.app.pattern);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
export const deploymentRequestSchema = z.object({ app: app.max(48), request: z.uuid(), commit }).strict().readonly();
const query = z.object({ app }).strict().readonly();
export const deploymentCancellationSchema = z.object({ app, request: z.uuid() }).strict().readonly();
const receipt = deploymentRequestSchema.unwrap().extend({ version: z.literal(1), plan: z.string().regex(/^[0-9a-f]{64}$/), deadline: z.number().int().positive(),
  cancelRequestedAt: z.number().int().positive().nullable().default(null),
  phase: z.enum(["prepared", "admitted", "applying", "verifying", "recovering", "held", "succeeded", "failed", "cancelled"]),
}).strict().readonly();
export type DeploymentRequest = z.infer<typeof deploymentRequestSchema>;
export const parseDeploymentRequest = (input: unknown) => {
  const parsed = deploymentRequestSchema.safeParse(input);
  return parsed.success ? ok<DeploymentRequest>(parsed.data) : err("invalid deployment request");
};
export const parseDeploymentQuery = (input: unknown) => {
  const parsed = query.safeParse(input);
  return parsed.success ? ok(parsed.data) : err("invalid deployment query");
};
export const parseDeploymentReceipt = (input: unknown) => {
  const parsed = receipt.safeParse(input);
  return parsed.success ? ok(parsed.data) : err("invalid deployment receipt");
};

export const parseDeploymentCancellation = (input: unknown) => {
  const parsed = deploymentCancellationSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : err("invalid deployment cancellation");
};

const completeReceipt = deploymentRequestSchema.unwrap().extend({ version: z.literal(2), plan: z.string().regex(/^[0-9a-f]{64}$/), deadline: z.number().int().positive(),
  cancelRequestedAt: z.number().int().positive().nullable(),
  phase: z.enum(["prepared", "admitted", "migrating", "ready-for-http", "held", "cancelling", "applying", "verifying", "recovering", "succeeded", "failed", "cancelled"]),
}).strict().readonly();
export const parseCompleteDeploymentReceipt = (input: unknown) => {
  const parsed = completeReceipt.safeParse(input);
  return parsed.success ? ok(parsed.data) : err("invalid complete deployment receipt");
};
