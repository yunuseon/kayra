import { createHash } from "node:crypto";
import { parseMigrationCleanupRecord, parseMigrationCleanupRequest, parseMigrationCleanupReceipt } from "../../contracts/migration-cleanup.ts";
import type { MigrationCleanupRequest, MigrationCleanupRecord } from "../../contracts/migration-cleanup.ts";
import type { MigrationResolutionActor } from "../../contracts/migration-resolution.ts";
import { parseJobPlan, jobPlanDigest } from "../../contracts/one-shot-job.ts";
import { migrationJobDescription } from "./migration-sequence.ts";
import { parseRolloutRequest } from "./rollout-request.ts";
import { rolloutMigrationEvidence } from "./rollout-resolution.ts";

export const migrationCleanupReceipt = (request: Pick<MigrationCleanupRequest, "app" | "run" | "step" | "purpose" | "attempt">, record: MigrationCleanupRecord) => {
  const result = parseMigrationCleanupReceipt({ version: 1, app: request.app, run: request.run, step: request.step, purpose: request.purpose, attempt: request.attempt, action: record.state.authority.action, phase: record.state.phase, deadline: record.state.authority.deadline });
  if (!result.ok) throw new Error(result.error); return result.value;
};

/** The parent writer authenticates ownership and commits this audited intent before cleanup effects. */
export const requestRolloutCleanup = async (input: ReturnType<typeof parseRolloutRequest>, statement: MigrationCleanupRequest, actor: MigrationResolutionActor,
  ports: { readonly read: (digest: string) => Promise<string>; readonly now: () => number }) => {
  const request = parseMigrationCleanupRequest(statement); if (!request.ok) throw new Error(request.error);
  const { operation, sequence, source } = await rolloutMigrationEvidence(input, ports.read);
  if (request.value.app !== sequence.scope.app || request.value.run !== sequence.scope.run) throw new Error("migration cleanup scope changed");
  const position = sequence.steps.findIndex((step) => step.id === request.value.step); const step = sequence.steps[position];
  const attempt = step?.attempts.find((attempt) => attempt.purpose === request.value.purpose && attempt.attempt === request.value.attempt);
  if (attempt === undefined) throw new Error("migration cleanup attempt is unavailable");
  const existing = attempt.cleanups?.find((item) => item.state.authority.action === request.value.action);
  if (existing !== undefined) {
    if (existing.reason !== request.value.reason || JSON.stringify(existing.actor) !== JSON.stringify(actor)) throw new Error("migration cleanup audit already differs");
    return Object.freeze({ operation, record: existing, receipt: migrationCleanupReceipt(request.value, existing), changed: false });
  }
  if (operation.completion !== undefined || operation.preparation.phase !== "held" || sequence.phase !== "held" || position !== sequence.position || step?.resolution !== undefined ||
    attempt.execution?.phase !== "held" || (attempt.cleanups?.length ?? 0) >= 8 || attempt.cleanups?.at(-1)?.state.phase !== undefined && attempt.cleanups.at(-1)?.state.phase !== "held") throw new Error("migration cleanup requires a current held attempt with no pending or completed cleanup");
  const bytes = await ports.read(attempt.artifact); const job = parseJobPlan(JSON.parse(bytes));
  if (!job.ok || createHash("sha256").update(bytes).digest("hex") !== attempt.artifact || jobPlanDigest(job.value) !== attempt.artifact ||
    jobPlanDigest(migrationJobDescription(sequence, source, position, attempt.purpose, attempt.attempt, attempt.createdAt)) !== attempt.artifact) throw new Error("migration cleanup attempt description changed");
  const now = ports.now(); if (!Number.isSafeInteger(now) || now < attempt.execution.createdAt) throw new Error("migration cleanup clock is unavailable");
  const record = parseMigrationCleanupRecord({ version: 1, actor, reason: request.value.reason,
    state: { version: 1, authority: { version: 1, action: request.value.action, job: attempt.artifact, createdAt: now, deadline: now + 30000 }, phase: "fencing", targets: [], barrier: null, completedAt: null } });
  const next = parseRolloutRequest({ ...operation, preparation: { ...operation.preparation, sequence: { ...sequence,
    steps: sequence.steps.map((item, index) => index !== position ? item : { ...item, attempts: item.attempts.map((item) => item === attempt ? { ...item, cleanups: [...(item.cleanups ?? []), record] } : item) }) } } });
  return Object.freeze({ operation: next, record, receipt: migrationCleanupReceipt(request.value, record), changed: true });
};

export const rolloutCleanupRecord = (operation: ReturnType<typeof parseRolloutRequest>, identity: Pick<MigrationCleanupRequest, "step" | "purpose" | "attempt" | "action">) =>
  operation.preparation.sequence?.steps.find((step) => step.id === identity.step)?.attempts.find((attempt) => attempt.purpose === identity.purpose && attempt.attempt === identity.attempt)?.cleanups?.find((record) => record.state.authority.action === identity.action);
