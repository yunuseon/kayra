import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { parseManagedLifecycleSource, managedLifecycleDescription, managedLifecycleSourceDigest } from "./managed-lifecycle-source.ts";
import { managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";

/** Only absence of every workload-effect intent permits metadata-only settlement. An empty maintenance child is safe only when the authenticated previous application has no consumers. */
const effectFree = (state: ManagedLifecycleStore, source: ManagedLifecycleSource) => {
  const operation = state.operation; const description = managedLifecycleDescription(source);
  if (operation.recoverySource !== null || operation.compatibilityFencedAt !== null ||
    operation.preparation !== null || operation.consumers !== null || operation.verification !== null || operation.recovery !== null || operation.recoveryVerification !== null ||
    operation.quiescence !== null && (operation.quiescence.nodes.length !== 0 || Object.values(source.previous?.source.application.services ?? {}).some((service) => service.role !== "retained-dependency")) ||
    JSON.stringify(state.owner) !== JSON.stringify(source.candidate.infrastructure.ownership) || source.createdAt !== operation.createdAt || description.admissionDeadline !== operation.admissionDeadline || operation.previousPlan !== (source.previous === null ? null : managedApplicationDigest(source.previous.source.application)) ||
    source.run !== operation.run || source.action !== operation.action || managedLifecycleSourceDigest(source) !== operation.source || description.admission.planDigest !== operation.plan || description.previous !== operation.previous || description.deadline !== operation.deadline ||
    (state.active?.record ?? null) !== operation.previous) throw new Error("managed lifecycle has no unstarted settlement proof");
  return source;
};

export const managedUnstartedSource = (input: ManagedLifecycleStore, retained: ManagedLifecycleSource) => {
  const state = parseManagedLifecycleStore(input); if (state.operation.phase !== "held" || state.operation.settled || state.operation.unstartedAt !== null) throw new Error("managed lifecycle is not awaiting unstarted intent");
  return effectFree(state, parseManagedLifecycleSource(retained));
};
/** Revalidates the persisted proof at the global accounting boundary, including after a lost settlement acknowledgement. */
export const managedUnstartedSettlementSource = (input: ManagedLifecycleStore, retained: ManagedLifecycleSource) => {
  const state = parseManagedLifecycleStore(input); if (!["settling", "complete"].includes(state.operation.phase) || state.operation.unstartedAt === null) throw new Error("managed lifecycle lacks unstarted settlement intent");
  return effectFree(state, parseManagedLifecycleSource(retained));
};
