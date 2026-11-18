import { createHash } from "node:crypto";
import { parseManagedDeploymentStatus } from "../../contracts/managed-deployment-status.ts";
import { managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import type { BuildPorts } from "../../contracts/build-artifact.ts";
import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { managedLifecycleDescription, parseManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import { parseManagedRelease } from "./managed-release.ts";

/** Owner projection of immutable evidence. A verified pointer is never interpreted as current service health. */
export const managedDeploymentStatus = async (input: unknown, sourceInput: unknown, ports: Pick<BuildPorts, "read">) => {
  const state = parseManagedLifecycleStore(input); const description = managedLifecycleDescription(parseManagedLifecycleSource(sourceInput)); const source = description.source; const operation = state.operation;
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (!same(state.owner, source.candidate.infrastructure.ownership) || operation.source !== createHash("sha256").update(JSON.stringify(source)).digest("hex") ||
    operation.run !== source.run || operation.action !== source.action || operation.createdAt !== source.createdAt || operation.plan !== description.admission.planDigest ||
    operation.previous !== description.previous || operation.previousPlan !== (source.previous === null ? null : managedApplicationDigest(source.previous.source.application)) ||
    operation.admissionDeadline !== description.admissionDeadline || operation.deadline !== description.deadline) throw new Error("managed status source disagrees");
  const target = (plan: typeof source.candidate) => Object.freeze({ plan: managedApplicationDigest(plan), commit: plan.commit });
  const verified = async (pointer: typeof state.active) => {
    if (pointer === null) return null;
    const bytes = await ports.read(pointer.record); const release = parseManagedRelease(JSON.parse(bytes)); const application = release.source.application;
    if (createHash("sha256").update(bytes).digest("hex") !== pointer.record || bytes !== JSON.stringify(release) || !same(application.infrastructure.ownership, state.owner) ||
      managedApplicationDigest(application) !== pointer.plan || release.verification.run !== pointer.run || release.verification.verified?.at !== pointer.verifiedAt) throw new Error("managed status verified release disagrees");
    return Object.freeze({ ...target(application), run: pointer.run, verifiedAt: pointer.verifiedAt, compatibilityEpoch: pointer.epoch });
  };
  const [active, lastGood] = await Promise.all([verified(state.active), verified(state.lastGood)]);
  const requested = target(source.candidate);
  const desired = operation.outcome !== null ? active === null ? null : Object.freeze({ plan: active.plan, commit: active.commit }) :
    operation.recoverySource === null ? requested : source.previous === null ? null : target(source.previous.source.application);
  const parsed = parseManagedDeploymentStatus({ version: 3, protocol: "managed-v3", runtime: "swarm", app: state.owner.app, incarnation: state.owner.incarnation,
    requested, desired, verifiedActive: active, lastKnownGood: lastGood, compatibilityEpoch: state.compatibilityEpoch,
    rollback: source.previous === null ? "no-previous-release" : operation.compatibilityFencedAt !== null || state.active !== null && state.active.epoch !== state.compatibilityEpoch ? "data-fenced" : source.candidate.rollout.rollback_compatible ? "eligible" : "application-incompatible",
    operation: { run: operation.run, strategy: source.candidate.rollout.strategy, phase: operation.phase, reason: operation.reason, outcome: operation.outcome,
      admissionDeadline: operation.admissionDeadline, deadline: operation.deadline, recoveryDeadline: operation.recoveryDeadline, cancelRequestedAt: operation.cancelRequestedAt, admitted: operation.admitted, settled: operation.settled },
    migrations: { phase: operation.preparation?.sequence?.phase ?? "not-started", reason: operation.preparation?.sequence?.reason ?? null,
      step: operation.preparation?.sequence?.steps[operation.preparation.sequence.position]?.id ?? null,
      resolutions: operation.resolutionReceipts.map((receipt) => Object.freeze({ step: receipt.step, id: receipt.resolution, outcome: receipt.outcome, at: receipt.recordedAt })) },
    requiredAction: operation.phase === "held" ? "inspect-and-resolve" : "none", runtimeObservation: "not-observed",
  });
  if (!parsed.ok) throw new Error(parsed.error); return parsed.value;
};
