import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { parseManagedLifecycleSource, managedLifecycleDescription, managedLifecycleSourceDigest } from "./managed-lifecycle-source.ts";
import { managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";

/** Only absence of every workload-effect intent permits metadata-only settlement. An empty maintenance child is safe only when the authenticated previous application has no consumers. */
export const managedUnstartedSource = (input: ManagedLifecycleStore, retained: ManagedLifecycleSource) => {
  const state = parseManagedLifecycleStore(input); const source = parseManagedLifecycleSource(retained); const operation = state.operation; const description = managedLifecycleDescription(source);
  if (operation.phase !== "held" || operation.settled || operation.recoverySource !== null || operation.unstartedAt !== null || operation.compatibilityFencedAt !== null ||
    operation.preparation !== null || operation.consumers !== null || operation.verification !== null || operation.recovery !== null || operation.recoveryVerification !== null ||
    operation.quiescence !== null && (operation.quiescence.nodes.length !== 0 || Object.values(source.previous?.source.application.services ?? {}).some((service) => service.role !== "retained-dependency")) ||
    JSON.stringify(state.owner) !== JSON.stringify(source.candidate.infrastructure.ownership) || source.createdAt !== operation.createdAt || description.admissionDeadline !== operation.admissionDeadline || operation.previousPlan !== (source.previous === null ? null : managedApplicationDigest(source.previous.source.application)) ||
    source.run !== operation.run || source.action !== operation.action || managedLifecycleSourceDigest(source) !== operation.source || description.admission.planDigest !== operation.plan || description.previous !== operation.previous || description.deadline !== operation.deadline ||
    (state.active?.record ?? null) !== operation.previous) throw new Error("managed lifecycle has no unstarted settlement proof");
  return source;
};
