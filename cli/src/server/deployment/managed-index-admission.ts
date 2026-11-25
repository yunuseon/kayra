import { parseDataOwnership } from "../../contracts/owned-volume.ts";
import { parseManagedAdmissionIdentity } from "../../contracts/managed-admission.ts";
import type { ManagedAdmissionIdentity, ManagedAdmissionClaim } from "../../contracts/managed-admission.ts";
import type { SwarmHostObservation } from "../../contracts/resource-authority.ts";
import { managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import { err, ok } from "../../lib/result.ts";
import { lifecycleIndexEntry } from "./lifecycle-app-index-state.ts";
import { parseLifecycleEnvelope } from "./lifecycle-envelope.ts";
import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { parseManagedLifecycleSource, managedLifecycleDescription, managedLifecycleSourceDigest } from "./managed-lifecycle-source.ts";
import { observeManagedAdmission, reserveManagedAdmission, settleManagedAdmission, fenceUnstartedManagedAdmission } from "./managed-admission-binding.ts";
import { managedUnstartedSettlementSource } from "./managed-unstarted-source.ts";
import { createHash } from "node:crypto";

type Context = { readonly owner: unknown; readonly envelope: unknown; readonly state: unknown; readonly source: unknown };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
/** No effects or authorization. The index supplies these authenticated snapshots while holding the existing app/global writers. */
export const managedIndexScope = (input: Omit<Context, "state">) => {
  try {
    const entry = lifecycleIndexEntry.parse(input.owner); const source = parseManagedLifecycleSource(input.source); const envelope = parseLifecycleEnvelope(input.envelope); const description = managedLifecycleDescription(source);
    const owner = parseDataOwnership({ version: 1, app: entry.app, incarnation: entry.incarnation, dataOwner: entry.dataOwner });
    const volumesRegistered = [...Object.values(source.candidate.services), ...Object.values(source.previous?.source.application.services ?? {}), ...source.retired.map((item) => item.plan)].every((service) => service.mounts.every((mount) => entry.volumes.some((volume) => same(volume, mount.volume))));
    const completed = envelope.ok ? envelope.value.managed?.find((item) => item.run === source.run && item.source === managedLifecycleSourceDigest(source) && item.completion !== null) : undefined;
    if (entry.phase !== "ready" || entry.protocol !== "managed-v3" || !owner.ok || !same(owner.value, source.candidate.infrastructure.ownership) || !envelope.ok || !volumesRegistered || envelope.value.tickets.app !== entry.app || envelope.value.tickets.incarnation !== entry.incarnation || envelope.value.registrationReceipt?.runtime !== "swarm" || completed === undefined && !same(envelope.value.registrationReceipt.metadata, source.candidate.infrastructure.registration)) return err("managed accounting lacks indexed scope");
    return ok(Object.freeze({ entry, owner: owner.value, source, managed: envelope.value.managed, operations: Object.freeze(envelope.value.operations.map((operation) => Object.freeze({ ...operation, descriptor: Object.freeze(operation.descriptor) }))), lifecyclePhase: envelope.value.fence?.lifecycle.phase, forwardPending: envelope.value.forward !== undefined, description }));
  } catch { return err("managed indexed scope is invalid"); }
};
export const managedIndexGate = (input: Omit<Context, "state">) => {
  const checked = managedIndexScope(input); if (!checked.ok) return checked; const scope = checked.value; const source = scope.source;
  const request = scope.managed?.find((value) => value.run === source.run);
  if (request === undefined || !same(request.owner, scope.owner) || request.source !== managedLifecycleSourceDigest(source) || request.action !== source.action || request.plan !== scope.description.admission.planDigest || request.createdAt !== source.createdAt || request.admissionDeadline !== scope.description.admissionDeadline || request.deadline !== scope.description.deadline ||
    request.completion === null && !scope.operations.some((value) => value.ticket === request.ticket && value.action === request.action && value.descriptor.kind === "deploy" && value.descriptor.planDigest === request.plan)) return err("managed accounting request binding disagrees");
  return ok(Object.freeze({ ...scope, request, activeGate: request.completion === null && scope.lifecyclePhase === "registered" && !scope.forwardPending }));
};
const authority = (input: Context, requested: ManagedAdmissionIdentity, claim: ManagedAdmissionClaim) => {
  try {
    const gate = managedIndexGate(input); if (!gate.ok) return gate; const scope = gate.value; const root = parseManagedLifecycleStore(input.state); const identity = parseManagedAdmissionIdentity(requested); const operation = root.operation; const source = scope.source;
    if (scope.entry.managedRoot !== "ready" || !same(scope.owner, root.owner) || !identity.ok || !same(scope.owner, identity.value.owner) || identity.value.run !== operation.run || identity.value.action !== operation.action || identity.value.source !== operation.source || identity.value.plan !== operation.plan || identity.value.deadline !== operation.admissionDeadline ||
      source.run !== operation.run || source.action !== operation.action || source.createdAt !== operation.createdAt || scope.request.source !== operation.source || operation.plan !== scope.description.admission.planDigest || operation.previous !== scope.description.previous || operation.previousPlan !== (scope.description.admission.previous === null ? null : managedApplicationDigest(scope.description.admission.previous)) || operation.admissionDeadline !== scope.description.admissionDeadline || operation.deadline !== scope.description.deadline ||
      managedApplicationDigest(claim.plan) !== operation.plan || claim.planDigest !== operation.plan || (claim.previous === null ? null : managedApplicationDigest(claim.previous)) !== operation.previousPlan ||
      scope.request.completion !== null && (operation.phase !== "complete" || scope.request.completion.outcome !== operation.outcome || scope.request.completion.rootSnapshot !== createHash("sha256").update(JSON.stringify(root)).digest("hex"))) return err("managed accounting lacks its indexed root");
    return ok(Object.freeze({ root, source, activeGate: scope.activeGate, forwardPending: scope.forwardPending }));
  } catch { return err("managed accounting context is invalid"); }
};

export const observeManagedIndexAdmission = (book: unknown, context: Context, identity: ManagedAdmissionIdentity, claim: ManagedAdmissionClaim) => {
  const checked = authority(context, identity, claim); return checked.ok ? observeManagedAdmission(book, identity, claim) : checked;
};
/** The indexed caller also checks current operator grants, capability enablement and this exact host observation before synchronizing. */
export const reserveManagedIndexAdmission = (book: unknown, context: Context, observation: SwarmHostObservation, identity: ManagedAdmissionIdentity, claim: ManagedAdmissionClaim, now: number) => {
  const checked = authority(context, identity, claim);
  if (!checked.ok || !checked.value.activeGate || checked.value.root.operation.phase !== "admitting" || checked.value.root.operation.cancelRequestedAt !== null || now >= checked.value.root.operation.admissionDeadline) return err("managed indexed admission is outside its scheduling gate");
  return reserveManagedAdmission(book, observation, identity, claim, now);
};
export const settleManagedIndexAdmission = (book: unknown, context: Context, identity: ManagedAdmissionIdentity, claim: ManagedAdmissionClaim, result: "target" | "previous" | "absent", unstarted: boolean) => {
  const checked = authority(context, identity, claim);
  if (!checked.ok || checked.value.forwardPending || !["settling", "complete"].includes(checked.value.root.operation.phase) || checked.value.root.operation.settlement !== result || (checked.value.root.operation.unstartedAt !== null) !== unstarted) return err("managed indexed settlement lacks its durable outcome");
  if (unstarted) { try { managedUnstartedSettlementSource(checked.value.root, checked.value.source); } catch { return err("managed indexed settlement lacks effect-free proof"); } return fenceUnstartedManagedAdmission(book, identity, claim); }
  return settleManagedAdmission(book, identity, claim, result);
};
