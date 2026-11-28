/* The legacy lifecycle envelope is shallow-frozen and transitions never mutate it. */
/* eslint-disable functional/prefer-immutable-types */
import { parseLifecycleEnvelope } from "./lifecycle-envelope.ts";
import { completeLifecyclePurge, lifecycleActionId, startLifecyclePurge } from "./lifecycle-fence.ts";
import { admitTicket, completeTicket, reserveTicket } from "./lifecycle-tickets.ts";
import type { ManagedPurgeInventory } from "./managed-purge-inventory.ts";
import { parseManagedPurge } from "./managed-purge-state.ts";
import type { ManagedPurge } from "./managed-purge-state.ts";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const envelope = (input: unknown) => {
  const parsed = parseLifecycleEnvelope(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

export const beginManagedPurgeEnvelope = (input: unknown, requested: string, removal: string, createdAt: number,
  operator: ManagedPurge["operator"], inventory: ManagedPurgeInventory) => {
  const current = envelope(input);
  const { removalTombstone: tombstone, removal: intent, managedPurge: prior } = current;
  if (tombstone?.request !== removal || intent === undefined || current.fence === null) throw new Error("managed purge requires completed removal");
  if (prior !== undefined) {
    if (prior.request !== requested || !same(prior.operator, operator)) throw new Error("managed purge request conflicts");
    return current;
  }
  const fence = startLifecyclePurge(current.fence, tombstone.action);
  const ticket = reserveTicket(current.tickets);
  if (!fence.ok || fence.value.lifecycle.phase !== "purging" || !ticket.ok) throw new Error("managed purge action is unavailable");
  const descriptor = Object.freeze({ kind: "purge" as const, ownershipGeneration: intent.owner.dataOwner });
  const admitted = admitTicket(ticket.value.state, ticket.value.ticket, descriptor);
  if (!admitted.ok || admitted.value.status !== "new") throw new Error("managed purge ticket is unavailable");
  const action = lifecycleActionId(fence.value, fence.value.lifecycle.purge);
  const managedPurge = parseManagedPurge({
    version: 1, request: requested, removal, ticket: ticket.value.ticket, action, createdAt, deadline: createdAt + 90_000,
    operator, phase: "preflight", reason: null, finishedAt: null, entries: inventory.map((entry) => ({ ...entry, phase: "pending" })),
  });
  return envelope({ ...current, tickets: admitted.value.state, fence: fence.value, managedPurge,
    operations: [...current.operations, { ticket: managedPurge.ticket, action, descriptor }],
  });
};

export const updateManagedPurgeEnvelope = (input: unknown, prior: ManagedPurge, nextInput: unknown) => {
  const current = envelope(input);
  const next = parseManagedPurge(nextInput);
  if (!same(current.managedPurge, prior) || prior.phase === "complete" || prior.phase === "held") throw new Error("managed purge lost its lifecycle");
  const { phase, reason, finishedAt, entries, ...identity } = next;
  if (!same({ ...prior, phase, reason, finishedAt, entries }, next) || next.entries.length !== prior.entries.length ||
    prior.phase === "preflight" && phase !== "deleting" && phase !== "held" || prior.phase === "deleting" && phase === "preflight" ||
    next.entries.filter((entry, index) => entry.phase !== prior.entries[index]?.phase).length > 1 ||
    next.entries.some((entry, index) => {
      const previous = prior.entries[index];
      return previous === undefined || !same({ ...previous, phase: entry.phase }, entry) ||
        previous.phase !== entry.phase && (phase !== "deleting" || prior.phase !== "deleting" ||
          previous.phase === "absent" || entry.phase === "pending");
    })) throw new Error("managed purge transition changed its intent");
  if (phase !== "complete") return envelope({ ...current, managedPurge: next });
  const fence = completeLifecyclePurge(current.fence, identity.action);
  const tickets = completeTicket(current.tickets, identity.ticket, "success");
  if (!fence.ok || !tickets.ok) throw new Error("managed purge completion lost its owner");
  return envelope({ ...current, fence: fence.value, tickets: tickets.value, operations: Object.freeze([]), managedPurge: next });
};
