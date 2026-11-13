import { z } from "zod";
import { err, ok } from "../lib/result.ts";

const app = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const step = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const outcome = z.enum(["applied", "not-applied"]);
export const migrationReasonSchema = z.string().trim().min(8).max(512).refine((value) => Array.from(value).every((character) => {
  const code = character.charCodeAt(0); return code >= 32 && (code < 127 || code > 159);
}));
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const migrationResolutionRequestSchema = z.object({ app, run: z.uuid(), step, outcome, reason: migrationReasonSchema }).strict().readonly();
const query = migrationResolutionRequestSchema.unwrap().pick({ app: true, run: true, step: true }).strict().readonly();
const actor = z.object({ kind: z.literal("operator-control"), identity: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,127}$/) }).strict().readonly();
const audit = z.object({ version: z.literal(1), id: digest, sequence: digest,
  scope: z.object({ app, incarnation: z.uuid(), run: z.uuid(), step }).strict().readonly(),
  actor, outcome, reason: migrationReasonSchema, at: positive,
}).strict().readonly();
const receipt = query.unwrap().extend({ version: z.literal(1), resolution: digest, outcome, recordedAt: positive, disposition: z.enum(["continue", "failed"]) }).strict().readonly();
const report = query.unwrap().extend({ version: z.literal(1), audit: audit.nullable() }).strict().readonly().refine((value) => value.audit === null ||
  value.audit.scope.app === value.app && value.audit.scope.run === value.run && value.audit.scope.step === value.step);
export type MigrationResolutionRequest = z.infer<typeof migrationResolutionRequestSchema>;
export type MigrationResolutionActor = z.infer<typeof actor>;
export type MigrationResolutionAudit = z.infer<typeof audit>;
export type MigrationResolutionReceipt = z.infer<typeof receipt>;

/** Actor identity comes from the privileged control transport, never this request. */
export const parseMigrationResolutionRequest = (input: unknown) => {
  const parsed = migrationResolutionRequestSchema.safeParse(input);
  return parsed.success ? ok<MigrationResolutionRequest>(parsed.data) : err("invalid migration resolution request");
};
export const parseMigrationResolutionQuery = (input: unknown) => {
  const parsed = query.safeParse(input);
  return parsed.success ? ok(parsed.data) : err("invalid migration resolution query");
};
export const parseMigrationResolutionActor = (input: unknown) => {
  const parsed = actor.safeParse(input);
  return parsed.success ? ok<MigrationResolutionActor>(parsed.data) : err("invalid operator audit identity");
};
/** Parsing an audit format grants no authority to resolve a migration. */
export const parseMigrationResolutionAudit = (input: unknown) => {
  const parsed = audit.safeParse(input);
  return parsed.success ? ok<MigrationResolutionAudit>(parsed.data) : err("invalid migration resolution audit");
};
export const parseMigrationResolutionReceipt = (input: unknown) => {
  const parsed = receipt.safeParse(input);
  return parsed.success ? ok<MigrationResolutionReceipt>(parsed.data) : err("invalid migration resolution receipt");
};
export const parseMigrationResolutionReport = (input: unknown) => {
  const parsed = report.safeParse(input);
  return parsed.success ? ok(parsed.data) : err("invalid migration resolution report");
};
