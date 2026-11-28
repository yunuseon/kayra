import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { parseManagedLifecycleSource, managedLifecycleDescription, managedLifecycleSourceDigest } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import { managedRecoverySnapshot } from "./managed-recovery-description.ts";
import { managedMigrationDescription, managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import { migrationSequenceDigest } from "../../contracts/migration-sequence.ts";
import { parseManagedGroupPreparation } from "./managed-group-preparation.ts";
import { verifyMigrationFences } from "./migration-fences-current.ts";
import { managedVerificationSnapshot } from "./managed-verification-source.ts";

export const managedRecoveryCheckTargets = (state: ManagedLifecycleStore, source: ManagedLifecycleSource) => {
  const unknown = state.operation.verification?.steps.filter((step) => step.execution !== null && step.execution.phase !== "complete" && step.execution.executionDeadline !== null) ?? [];
  if (unknown.length === 0) return undefined;
  if (state.operation.consumers === null) throw new Error("managed recovery check witnesses missing");
  const snapshot = managedVerificationSnapshot({ kind: "deployment", application: source.candidate, certificate: state.operation.consumers });
  return Object.freeze(unknown.map((step) => { const witness = snapshot.witnesses.find((item) => item.name === step.service); if (step.target === null || witness === undefined || JSON.stringify(step.target.action) !== JSON.stringify(witness.action)) throw new Error("managed recovery check target disagrees"); return Object.freeze({ target: step.target, native: witness.native }); }));
};

/** A policy decision, not effect authority. The caller must persist the selected start/deadline before creating a recovery child and recheck native job fences before every recovery effect. */
export const managedRecoverySource = (input: ManagedLifecycleStore, retained: ManagedLifecycleSource, now: number) => {
  const state = parseManagedLifecycleStore(input); const source = parseManagedLifecycleSource(retained); const description = managedLifecycleDescription(source); const operation = state.operation;
  const checkWindow = source.previous === null ? 0 : Math.max(90_000, source.previous.source.application.rollout.checks.reduce((total, check) => total + (90 + check.timeout_seconds) * 1000, 0));
  if (source.version === 3 || operation.phase !== "held" || !operation.admitted || operation.settled || source.run !== operation.run || source.action !== operation.action || managedLifecycleSourceDigest(source) !== operation.source || operation.plan !== description.admission.planDigest || operation.previous !== description.previous || operation.deadline !== description.deadline ||
    operation.preparation === null && (operation.quiescence === null || source.previous === null || operation.consumers !== null || operation.verification !== null) || (source.previous === null ? state.active !== null : !description.admission.rollbackEligible || state.active?.record !== operation.previous || state.active.epoch !== state.compatibilityEpoch || operation.compatibilityFencedAt !== null) ||
    !Number.isSafeInteger(now) || now < operation.createdAt || now + 90_000 + checkWindow > operation.deadline) throw new Error("managed recovery is not eligible under the recorded lifecycle");
  const checks = managedRecoveryCheckTargets(state, source);
  return managedRecoverySnapshot({ candidate: source.candidate, previous: source.previous?.source.application ?? null, preparation: operation.preparation, consumers: operation.consumers, baselines: description.baselines, ...(operation.preparation === null ? { retained: source.retained.filter((value) => source.previous?.source.application.services[value.name] !== undefined).map(({ name, action, native }) => Object.freeze({ name, action, native })) } : {}),
    maintenance: operation.quiescence === null ? null : { certificate: operation.quiescence, source: { candidate: source.candidate, previous: source.previous?.source.application ?? null, baselines: description.baselines.map((value) => Object.freeze({ ...value, prior: Object.freeze([]) })), run: source.run, action: source.action, startedAt: operation.quiescence.createdAt } }, ...(checks === undefined ? {} : { checks }),
  });
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
