import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { parseManagedLifecycleSource, managedLifecycleDescription, managedLifecycleSourceDigest } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import { managedRecoverySnapshot } from "./managed-recovery-description.ts";
import { managedMigrationDescription, managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import { migrationSequenceDigest } from "../../contracts/migration-sequence.ts";
import { parseManagedGroupPreparation } from "./managed-group-preparation.ts";
import { verifyMigrationFences } from "./migration-fences-current.ts";

/** A policy decision, not effect authority. The caller must persist the selected start/deadline before creating a recovery child and recheck native job fences before every recovery effect. */
export const managedRecoverySource = (input: ManagedLifecycleStore, retained: ManagedLifecycleSource, now: number) => {
  const state = parseManagedLifecycleStore(input); const source = parseManagedLifecycleSource(retained); const description = managedLifecycleDescription(source); const operation = state.operation;
  const checkWindow = source.previous === null ? 0 : Math.max(90_000, source.previous.source.application.rollout.checks.reduce((total, check) => total + (90 + check.timeout_seconds) * 1000, 0));
  if (operation.phase !== "held" || !operation.admitted || operation.settled || source.run !== operation.run || source.action !== operation.action || managedLifecycleSourceDigest(source) !== operation.source || operation.plan !== description.admission.planDigest || operation.previous !== description.previous || operation.deadline !== description.deadline ||
    operation.preparation === null || (source.previous === null ? state.active !== null : source.candidate.rollout.strategy !== "rolling" || !description.admission.rollbackEligible || state.active?.record !== operation.previous || state.active.epoch !== state.compatibilityEpoch || operation.compatibilityFencedAt !== null) ||
    !Number.isSafeInteger(now) || now < operation.createdAt || now + 90_000 + checkWindow > operation.deadline) throw new Error("managed recovery is not eligible under the recorded lifecycle");
  if (operation.verification?.steps.some((step) => step.execution !== null && step.execution.phase !== "complete" && step.execution.executionDeadline !== null)) throw new Error("managed recovery requires cessation of every possibly started check");
  return managedRecoverySnapshot({ candidate: source.candidate, previous: source.previous?.source.application ?? null, preparation: operation.preparation, consumers: operation.consumers, baselines: description.baselines });
};

/** Never treats an expired/held job as stopped, or a stopped job as an applied migration. The immutable recovery description separately validates outcomes. */
export const verifyManagedRecoveryJobs = async (input: ManagedLifecycleSource, preparation: NonNullable<ManagedLifecycleStore["operation"]["preparation"]>, ports: Parameters<typeof verifyMigrationFences>[2]) => {
  const source = parseManagedLifecycleSource(input); const prefix = parseManagedGroupPreparation(preparation);
  if (prefix.plan !== managedApplicationDigest(source.candidate) || prefix.run !== source.run || prefix.action !== source.action) throw new Error("managed recovery migration ownership disagrees");
  if (prefix.sequence === null) return;
  const description = managedMigrationDescription(source.candidate, source.run); if (!description.ok) throw new Error("managed recovery migration description is unavailable");
  if (migrationSequenceDigest(description.value) !== prefix.sequencePlan) throw new Error("managed recovery migration description changed");
  await verifyMigrationFences(prefix.sequence, description.value, ports);
};
