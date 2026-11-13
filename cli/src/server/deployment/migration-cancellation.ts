import type { MigrationSequenceState } from "./migration-sequence.ts";
import { migrationAttemptBarrier } from "./migration-sequence.ts";

const outcome = (step: MigrationSequenceState["steps"][number]) => {
  if (step.attempts.some((attempt) => attempt.execution !== null && migrationAttemptBarrier(attempt) === null)) return undefined;
  if (step.resolution !== undefined) return step.resolution.outcome;
  if (step.phase === "applied") return "applied" as const;
  const last = step.attempts.at(-1); const execution = last?.execution;
  if (last?.purpose === "probe" && execution?.evidence?.kind === "succeeded" && execution.expiry === null && execution.evidence.probe !== "unknown" && execution.evidence.probe !== null) return execution.evidence.probe;
  const migrations = step.attempts.filter((attempt) => attempt.purpose === "migration");
  if (migrations.every((attempt) => attempt.execution === null || attempt.execution.evidence?.kind === "not-started")) return "unstarted" as const;
  return undefined;
};

/** Known app outcomes only; cancellation never converts an unknown effect into success or failure. */
export const migrationCancellationProof = (sequence: MigrationSequenceState | null) => {
  const outcomes = sequence?.steps.map((step) => Object.freeze({ step: step.id, outcome: outcome(step) })) ?? [];
  if (outcomes.some((item) => item.outcome === undefined)) return undefined;
  return Object.freeze({ version: 1 as const, sequence: sequence?.plan ?? null,
    outcomes: Object.freeze(outcomes.flatMap((item) => Object.freeze(item.outcome === undefined ? [] : [Object.freeze({ step: item.step, outcome: item.outcome })]))) });
};
