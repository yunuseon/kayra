import { managedRecoveryProgress } from "./managed-recovery-progress.ts";
import { parseManagedDeploymentStatus } from "../../contracts/managed-deployment-status.ts";
import { managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import type { BuildPorts } from "../../contracts/build-artifact.ts";
import { managedDeploymentEvidence } from "./managed-deployment-evidence.ts";

/** Owner projection of immutable evidence. A verified pointer is never interpreted as current service health. */
export const managedDeploymentStatus = async (input: unknown, sourceInput: unknown, ports: Pick<BuildPorts, "read">) => {
  const evidence = await managedDeploymentEvidence(input, sourceInput, ports); const { state, source } = evidence; const operation = state.operation;
  const target = (plan: typeof source.candidate) => Object.freeze({ plan: managedApplicationDigest(plan), commit: plan.commit });
  const verified = (item: typeof evidence.active) => item === null ? null : Object.freeze({ ...target(item.release.source.application), run: item.pointer.run, verifiedAt: item.pointer.verifiedAt, compatibilityEpoch: item.pointer.epoch });
  const active = verified(evidence.active); const lastGood = verified(evidence.lastGood);
  const requested = target(source.candidate);
  const desired = operation.outcome !== null ? active === null ? null : Object.freeze({ plan: active.plan, commit: active.commit }) :
    operation.recoverySource === null ? requested : source.previous === null ? null : target(source.previous.source.application);
  const parsed = parseManagedDeploymentStatus({ version: 3, protocol: "managed-v3", runtime: "swarm", app: state.owner.app, incarnation: state.owner.incarnation,
    requested, desired, verifiedActive: active, lastKnownGood: lastGood, compatibilityEpoch: state.compatibilityEpoch,
    rollback: source.version === 3 ? "data-fenced" : source.previous === null ? "no-previous-release" : operation.compatibilityFencedAt !== null || state.active !== null && state.active.epoch !== state.compatibilityEpoch ? "data-fenced" : source.candidate.rollout.rollback_compatible ? "eligible" : "application-incompatible",
    operation: { run: operation.run, strategy: source.candidate.rollout.strategy, phase: operation.phase, reason: operation.reason, outcome: operation.outcome,
      admissionDeadline: operation.admissionDeadline, deadline: operation.deadline, recoveryDeadline: operation.recoveryDeadline, cancelRequestedAt: operation.cancelRequestedAt, admitted: operation.admitted, settled: operation.settled },
    migrations: { phase: operation.preparation?.sequence?.phase ?? "not-started", reason: operation.preparation?.sequence?.reason ?? null,
      step: operation.preparation?.sequence?.steps[operation.preparation.sequence.position]?.id ?? null,
      resolutions: operation.resolutionReceipts.map((receipt) => Object.freeze({ step: receipt.step, id: receipt.resolution, outcome: receipt.outcome, at: receipt.recordedAt })) },
    recovery: managedRecoveryProgress(state),
    requiredAction: operation.phase === "held" ? "inspect-and-resolve" : "none", runtimeObservation: "not-observed",
  });
  if (!parsed.ok) throw new Error(parsed.error); return parsed.value;
};
