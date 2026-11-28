import { parseDataOwnership } from "../../contracts/owned-volume.ts";
import { parseLifecycleEnvelope } from "./lifecycle-envelope.ts";
import { completeLifecycleRemoval, lifecycleActionId, requestLifecycleRemoval, settleLifecycleWork, startLifecycleRemoval } from "./lifecycle-fence.ts";
import { admitTicket, completeTicket, reserveTicket } from "./lifecycle-tickets.ts";
import { parseManagedLifecycleRequest } from "./managed-lifecycle-request.ts";
import { managedRemovalTombstone, parseManagedRemovalIntent } from "./managed-removal-intent.ts";
import type { ManagedRemovalIntent } from "./managed-removal-intent.ts";
import type { IndexEntry } from "./lifecycle-app-index-state.ts";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Acceptance records the removal fence and data inventory before any workload or registration effect. */
export const requestManagedRemovalEnvelope = (input: unknown, indexed: IndexEntry, request: string, operator: ManagedRemovalIntent["operator"], createdAt: number) => {
  const checked = parseLifecycleEnvelope(input);
  if (!checked.ok) throw new Error(checked.error);
  const current = checked.value;
  const ownership = parseDataOwnership({ version: 1, app: indexed.app, incarnation: indexed.incarnation, dataOwner: indexed.dataOwner });
  const registration = current.registrationReceipt;
  if (indexed.protocol !== "managed-v3" || indexed.phase !== "ready" || !ownership.ok || registration?.runtime !== "swarm" ||
    current.tickets.app !== indexed.app || current.tickets.incarnation !== indexed.incarnation) throw new Error("managed removal requires an owned Swarm registration");
  if (current.removal !== undefined) {
    if (current.removal.request !== request || !same(current.removal.operator, operator) ||
      !same(current.removal.owner, ownership.value) || !same(current.removal.volumes, indexed.volumes)) throw new Error("managed removal intent conflicts");
    return Object.freeze({ state: current, removal: current.removal, changed: false });
  }
  if (current.managed?.some((item) => item.run === request) || current.forward?.run === request) throw new Error("managed removal request conflicts with an existing operation");
  if (current.forward?.phase === "transferring") throw new Error("managed removal requires forward handoff reconciliation");
  if (current.http !== undefined || current.rollout !== undefined || (current.rollouts?.length ?? 0) !== 0 ||
    current.fence?.lifecycle.phase !== "registered" || current.fence.lifecycle.active?.kind === "register") throw new Error("managed removal lifecycle is unavailable");

  const fenced = requestLifecycleRemoval(current.fence);
  const reserved = reserveTicket(current.tickets);
  if (!fenced.ok || fenced.value.lifecycle.phase !== "removal-requested" || !reserved.ok) throw new Error("managed removal action cannot be allocated");
  const action = lifecycleActionId(fenced.value, fenced.value.lifecycle.removal);
  const descriptor = Object.freeze({ kind: "remove" as const, ownershipGeneration: ownership.value.dataOwner });
  const admitted = admitTicket(reserved.value.state, reserved.value.ticket, descriptor);
  if (!admitted.ok || admitted.value.status !== "new") throw new Error("managed removal ticket cannot be admitted");
  const removal = parseManagedRemovalIntent({
    version: 1, phase: "requested", request, ticket: reserved.value.ticket, action, createdAt, owner: ownership.value,
    registration: registration.metadata, volumes: indexed.volumes, operator,
    ...(current.forward === undefined ? {} : { interruptedForward: current.forward }),
  });
  const next = parseLifecycleEnvelope({
    ...current, forward: undefined, fence: fenced.value, tickets: admitted.value.state, removal,
    operations: [...current.operations, { ticket: removal.ticket, action: removal.action, descriptor }],
  });
  if (!next.ok || next.value.removal === undefined) throw new Error("managed removal envelope is invalid");
  return Object.freeze({ state: next.value, removal: next.value.removal, changed: true });
};

/** Custody ends only after the owner settles runtime accounting and verifies the platform withdrawal of this registration. */
// eslint-disable-next-line functional/prefer-immutable-types -- the validated lifecycle envelope is shallow-frozen and transitions do not mutate it
export const completeManagedRemovalEnvelope = (input: unknown, observed: unknown, checkpointRun: string | null) => {
  const parsed = parseLifecycleEnvelope(input);
  if (!parsed.ok) throw new Error(parsed.error);
  const current = parsed.value;
  const tombstone = managedRemovalTombstone.parse(observed);
  const { removal, removalAccounting: accounting, fence } = current;
  if (current.removalTombstone !== undefined) {
    if (!same(current.removalTombstone, tombstone)) throw new Error("managed removal tombstone conflicts");
    return current;
  }
  if (removal?.request !== tombstone.request || accounting?.effects !== tombstone.effects || fence?.lifecycle.phase !== "removal-requested") throw new Error("managed removal finalization lacks the owning action");
  const active = fence.lifecycle.active;
  const pending = current.managed?.find((item) => item.completion === null);
  if ((active === null) !== (pending === undefined) || active !== null && (active.kind !== "deploy" ||
    pending?.action !== lifecycleActionId(fence, active.sequence))) throw new Error("managed removal cannot reconcile pending work");
  const inactive = pending === undefined ? { ok: true as const, value: fence } : settleLifecycleWork(fence, pending.action);
  if (!inactive.ok) throw new Error("managed removal lost pending ownership");
  const removing = startLifecycleRemoval(inactive.value, Object.freeze(removal.volumes.map((volume) => volume.name)));
  if (!removing.ok) throw new Error(removing.error);
  const removed = completeLifecycleRemoval(removing.value, removal.action);
  const settled = pending === undefined ? { ok: true as const, value: current.tickets } : completeTicket(current.tickets, pending.ticket, "cancelled");
  if (!removed.ok || !settled.ok) throw new Error("managed removal cannot settle lifecycle");
  const tickets = completeTicket(settled.value, removal.ticket, "success");
  if (!tickets.ok) throw new Error(tickets.error);
  const managed = pending === undefined ? current.managed : current.managed?.map((item) =>
    item === pending ? parseManagedLifecycleRequest({ ...item, completion: {
      outcome: "removed", disposition: "cancelled", rootSnapshot: pending.run === checkpointRun ? tombstone.checkpoint : null, removal: removal.request,
    } }) : item);
  const next = parseLifecycleEnvelope({
    ...current, tickets: tickets.value, fence: removed.value, operations: Object.freeze([]), managed, removalTombstone: tombstone,
  });
  if (!next.ok) throw new Error(next.error);
  return next.value;
};
