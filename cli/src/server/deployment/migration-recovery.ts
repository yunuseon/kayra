import type { Migration } from "../../contracts/rollout.ts";
import { typed } from "../../lib/typed.ts";

/** An authoritative lookup of the migration's stable runtime identity. */
export type MigrationObservation = "unobserved" | "missing" | "running" | "succeeded" | "failed" | "unavailable";
export type ProbeOutcome = "applied" | "not-applied" | "unknown";
export type ProbeObservation = "unobserved" | "missing" | "running" | "unavailable" | ProbeOutcome;
export type ProbeIntent = { readonly deadline: number; readonly observation: ProbeObservation };
export type MigrationRecovery = {
  readonly runId: string;
  readonly step: Migration;
  /** Absolute Unix milliseconds, persisted with the migration intent. */
  readonly deadline: number;
  readonly now: number;
  readonly observation: MigrationObservation;
  /** Absent until a separate probe intent and its absolute deadline are persisted. */
  readonly probe?: ProbeIntent;
};

type Reference = { readonly runId: string; readonly stepId: string };
type RecoveryDecision = Reference & (
  | { readonly kind: "observe-migration" }
  | { readonly kind: "wait-migration"; readonly deadline: number }
  | { readonly kind: "retry-migration"; readonly deadline: number }
  | { readonly kind: "record-probe-intent"; readonly deadline: number }
  | { readonly kind: "observe-probe" }
  | { readonly kind: "wait-probe"; readonly deadline: number }
  | { readonly kind: "applied" }
  | { readonly kind: "intervention"; readonly reason: string }
);

/**
 * Decide only from a persisted intent and fresh, authoritative runtime observations.
 * The caller must persist each returned intent before an effect and bind observations
 * to the recorded run and step. In particular, missing must not mean "lookup failed".
 */
export const decideMigrationRecovery = (input: MigrationRecovery) => {
  const ref: Reference = { runId: input.runId, stepId: input.step.id };
  const intervention = (reason: string) => typed<RecoveryDecision>({ ...ref, kind: "intervention", reason });
  if (input.runId.length === 0 || input.step.id.length === 0 || !Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.deadline) || input.deadline <= 0 || input.now < 0) return intervention("invalid recorded identity or deadline");
  if (!["unobserved", "missing", "running", "succeeded", "failed", "unavailable"].some((value) => value === input.observation)) return intervention("invalid migration observation");
  if (input.observation === "unobserved") return typed<RecoveryDecision>({ ...ref, kind: "observe-migration" });
  if (input.observation === "unavailable") return intervention("migration state could not be observed");
  if (input.observation === "succeeded") return typed<RecoveryDecision>({ ...ref, kind: "applied" });
  if (input.observation === "running") return input.now < input.deadline
    ? typed<RecoveryDecision>({ ...ref, kind: "wait-migration", deadline: input.deadline })
    : intervention("migration is still running after its deadline");
  if (input.step.recovery.kind === "replay-safe" && input.observation === "missing") return intervention("missing migration evidence is ambiguous");
  if (input.step.recovery.kind === "replay-safe") return input.now < input.deadline
    ? typed<RecoveryDecision>({ ...ref, kind: "retry-migration", deadline: input.deadline })
    : intervention("migration deadline expired before a safe retry");
  const timeoutMs = input.step.recovery.timeout_seconds * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return intervention("invalid probe timeout");
  if (input.probe === undefined) {
    const deadline = input.now + timeoutMs;
    return Number.isSafeInteger(deadline)
      ? typed<RecoveryDecision>({ ...ref, kind: "record-probe-intent", deadline })
      : intervention("probe deadline is out of range");
  }
  if (!Number.isSafeInteger(input.probe.deadline) || input.probe.deadline <= 0) return intervention("invalid recorded probe deadline");
  if (!["unobserved", "missing", "running", "unavailable", "applied", "not-applied", "unknown"].some((value) => value === input.probe?.observation)) return intervention("invalid probe observation");
  if (input.probe.observation === "unobserved") return typed<RecoveryDecision>({ ...ref, kind: "observe-probe" });
  if (input.probe.observation === "applied") return typed<RecoveryDecision>({ ...ref, kind: "applied" });
  if (input.probe.observation === "not-applied") return intervention("probe reports not applied; migration is not declared replay-safe");
  if (input.probe.observation === "unknown" || input.probe.observation === "unavailable") return intervention("migration outcome is unresolved");
  if (input.now >= input.probe.deadline) return intervention("probe deadline expired");
  return input.probe.observation === "running"
    ? typed<RecoveryDecision>({ ...ref, kind: "wait-probe", deadline: input.probe.deadline })
    : intervention("missing probe evidence is ambiguous after interruption");
};
