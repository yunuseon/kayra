import { createHash } from "node:crypto";
import { jobPlanDigest, parseJobPlan } from "../../contracts/one-shot-job.ts";
import type { JobPort } from "../../contracts/one-shot-job.ts";
import type { MigrationSequencePlan } from "../../contracts/migration-sequence.ts";
import { migrationAttemptBarrier, migrationDescriptionForState, migrationJobDescription } from "./migration-sequence.ts";
import type { MigrationSequenceState } from "./migration-sequence.ts";

/** Read-only fresh cessation evidence. The parent bounds the whole inspection and authenticates the lifecycle/admission; a fence does not establish migration outcome. */
export const verifyMigrationFences = async (state: MigrationSequenceState, source: MigrationSequencePlan, ports: { readonly read: (digest: string) => Promise<string>; readonly native: Pick<JobPort, "observe"> }) => {
  const plan = migrationDescriptionForState(state, source);
  for (const [position, step] of state.steps.entries()) for (const attempt of step.attempts) {
    const bytes = await ports.read(attempt.artifact); const raw: unknown = JSON.parse(bytes); const job = parseJobPlan(raw);
    if (!job.ok || createHash("sha256").update(bytes).digest("hex") !== attempt.artifact || jobPlanDigest(job.value) !== attempt.artifact || jobPlanDigest(migrationJobDescription(state, plan, position, attempt.purpose, attempt.attempt, attempt.createdAt)) !== attempt.artifact) throw new Error("migration fence job description changed");
    const observed = await ports.native.observe(job.value);
    if (attempt.execution === null) { if (observed.status !== "absent") throw new Error("uncreated migration attempt has unexpected runtime state"); continue; }
    if (observed.status !== "owned" || !observed.barrier || observed.state !== "created" || observed.id !== migrationAttemptBarrier(attempt) || observed.plan !== attempt.artifact) throw new Error("migration has no current owned fence proof");
  }
};
