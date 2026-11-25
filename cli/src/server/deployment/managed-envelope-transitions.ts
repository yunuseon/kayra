import { createHash } from "node:crypto";
import { parseLifecycleEnvelope } from "./lifecycle-envelope.ts";
import { parseManagedLifecycleSource, managedLifecycleDescription, managedLifecycleSourceDigest } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { parseManagedLifecycleRequest } from "./managed-lifecycle-request.ts";
import { beginLifecycleWork, lifecycleActionId, settleLifecycleWork } from "./lifecycle-fence.ts";
import { admitTicket, completeTicket, reserveTicket } from "./lifecycle-tickets.ts";

// eslint-disable-next-line functional/prefer-immutable-types -- the legacy parser owns and validates its shallow-frozen envelope; transitions never mutate it
const envelope = (input: unknown) => { const value = parseLifecycleEnvelope(input); if (!value.ok) throw new Error(value.error); return value.value; };
/** Pure lifecycle-gate transitions. Artifact existence, indexed ownership, current grants and shared-book settlement remain the indexed caller's responsibility. */
export const prepareManagedEnvelope = (before: unknown, input: ManagedLifecycleSource, now: number) => {
  const current = envelope(before);
  const source = parseManagedLifecycleSource(input); const description = managedLifecycleDescription(source); const identity = managedLifecycleSourceDigest(source);
  const existing = current.managed?.find((item) => item.run === source.run);
  if (existing !== undefined) { if (existing.source !== identity) throw new Error("managed lifecycle request conflicts"); return Object.freeze({ state: current, request: existing, changed: false }); }
  if (current.forward !== undefined) throw new Error("managed forward continuation owns lifecycle");
  if (!Number.isSafeInteger(now) || now < source.createdAt || now >= description.admissionDeadline) throw new Error("managed lifecycle request admission expired");
  if (current.http !== undefined || current.rollout !== undefined || (current.rollouts?.length ?? 0) !== 0 || (current.managed?.length ?? 0) >= 1024 || current.registrationReceipt?.runtime !== "swarm" || JSON.stringify(current.registrationReceipt.metadata) !== JSON.stringify(source.candidate.infrastructure.registration) || source.candidate.infrastructure.ownership.app !== current.tickets.app || source.candidate.infrastructure.ownership.incarnation !== current.tickets.incarnation) throw new Error("managed lifecycle registration or protocol disagrees");
  const fence = beginLifecycleWork(current.fence, "deploy"); const reserved = reserveTicket(current.tickets); if (!fence.ok || !reserved.ok) throw new Error("managed lifecycle is busy or tickets exhausted");
  const active = fence.value.lifecycle; if (active.phase !== "registered" || active.active === null || lifecycleActionId(fence.value, active.active.sequence) !== source.action) throw new Error("managed lifecycle action is outside the shared fence");
  const descriptor = Object.freeze({ kind: "deploy" as const, planDigest: description.admission.planDigest }); const accepted = admitTicket(reserved.value.state, reserved.value.ticket, descriptor); if (!accepted.ok || accepted.value.status !== "new") throw new Error("managed lifecycle ticket admission failed");
  const request = parseManagedLifecycleRequest({ version: 1, protocol: "managed-v3", owner: source.candidate.infrastructure.ownership, run: source.run, ticket: reserved.value.ticket, action: source.action, source: identity, plan: descriptor.planDigest, createdAt: source.createdAt, admissionDeadline: description.admissionDeadline, deadline: description.deadline, completion: null });
  return Object.freeze({ state: envelope({ ...current, fence: fence.value, tickets: accepted.value.state, operations: [...current.operations, { ticket: request.ticket, action: request.action, descriptor }], managed: [...(current.managed ?? []), request] }), request, changed: true });
};

export const completeManagedEnvelope = (before: unknown, input: unknown, record: string) => {
  const current = envelope(before);
  if (current.forward !== undefined) throw new Error("managed forward continuation owns lifecycle");
  const state = parseManagedLifecycleStore(input); const operation = state.operation; const request = current.managed?.find((item) => item.run === operation.run);
  if (request === undefined || JSON.stringify(state.owner) !== JSON.stringify(request.owner) || state.owner.app !== current.tickets.app || state.owner.incarnation !== current.tickets.incarnation || request.source !== operation.source || request.action !== operation.action || request.plan !== operation.plan || request.createdAt !== operation.createdAt || request.admissionDeadline !== operation.admissionDeadline || request.deadline !== operation.deadline || operation.phase !== "complete" || !operation.settled || operation.outcome === null || createHash("sha256").update(JSON.stringify(state)).digest("hex") !== record) throw new Error("managed completion requires its synchronized terminal root");
  const disposition = operation.cancelRequestedAt !== null ? "cancelled" as const : operation.outcome === "deployed" ? "success" as const : "failure" as const;
  const completed = parseManagedLifecycleRequest({ ...request, completion: { rootSnapshot: record, outcome: operation.outcome, disposition } });
  if (request.completion !== null) { if (JSON.stringify(request) !== JSON.stringify(completed)) throw new Error("managed lifecycle completion conflicts"); return Object.freeze({ state: current, request, changed: false }); }
  const fence = settleLifecycleWork(current.fence, request.action); const tickets = completeTicket(current.tickets, request.ticket, disposition); if (!fence.ok || !tickets.ok) throw new Error("managed lifecycle completion lost shared ownership");
  return Object.freeze({ state: envelope({ ...current, fence: fence.value, tickets: tickets.value, operations: current.operations.filter((item) => item.ticket !== request.ticket), managed: current.managed?.map((item) => item.run === request.run ? completed : item) }), request: completed, changed: true });
};
