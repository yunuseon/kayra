import { z } from "zod";
import { err, ok } from "../lib/result.ts";
import { parseJobCleanupState } from "./job-cleanup.ts";
import { migrationReasonSchema, migrationResolutionRequestSchema, parseMigrationResolutionActor } from "./migration-resolution.ts";

export const migrationCleanupRequestSchema = migrationResolutionRequestSchema.unwrap().omit({ outcome: true }).extend({
  purpose: z.enum(["migration", "probe"]), attempt: z.number().int().min(1).max(8), action: z.uuid(),
}).strict().readonly();
const query = migrationResolutionRequestSchema.unwrap().pick({ app: true, run: true, step: true }).strict().readonly();
const record = z.object({ version: z.literal(1), actor: z.unknown(), reason: migrationReasonSchema, state: z.unknown() }).strict().readonly();
export type MigrationCleanupIdentity = Readonly<Pick<z.infer<typeof migrationCleanupRequestSchema>, "app" | "run" | "step" | "purpose" | "attempt" | "action">>;
export type MigrationCleanupRequest = z.infer<typeof migrationCleanupRequestSchema>;
export const parseMigrationCleanupRequest = (input: unknown) => {
  const parsed = migrationCleanupRequestSchema.safeParse(input);
  return parsed.success ? ok<MigrationCleanupRequest>(parsed.data) : err("invalid migration cleanup request");
};
export const parseMigrationCleanupRecord = (input: unknown) => {
  const parsed = record.safeParse(input); if (!parsed.success) throw new Error("invalid migration cleanup audit record");
  const actor = parseMigrationResolutionActor(parsed.data.actor); const state = parseJobCleanupState(parsed.data.state);
  if (!actor.ok) throw new Error("invalid migration cleanup actor or reason");
  return Object.freeze({ version: parsed.data.version, actor: actor.value, reason: parsed.data.reason, state });
};
export type MigrationCleanupRecord = ReturnType<typeof parseMigrationCleanupRecord>;
const receipt = query.unwrap().extend({ version: z.literal(1), purpose: z.enum(["migration", "probe"]), attempt: z.number().int().min(1).max(8), action: z.uuid(),
  phase: z.enum(["fencing", "complete", "held"]), deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().readonly();
export const parseMigrationCleanupReceipt = (input: unknown) => {
  const parsed = receipt.safeParse(input);
  return parsed.success ? ok(parsed.data) : err("invalid migration cleanup receipt");
};

const report = query.unwrap().extend({ version: z.literal(1), cleanups: z.array(z.object({ purpose: z.enum(["migration", "probe"]), attempt: z.number().int().min(1).max(8),
  records: z.array(z.unknown()).min(1).max(8).readonly(),
}).strict().readonly()).max(9).readonly() }).strict().readonly();
export const parseMigrationCleanupReport = (input: unknown) => {
  const parsed = report.safeParse(input); if (!parsed.success) throw new Error("invalid migration cleanup report");
  return Object.freeze({ ...parsed.data, cleanups: Object.freeze(parsed.data.cleanups.map((row) => Object.freeze({ ...row, records: Object.freeze(row.records.map(parseMigrationCleanupRecord)) }))) });
};
