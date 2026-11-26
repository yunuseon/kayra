import { parseDataOwnership } from "../../contracts/owned-volume.ts";
import { parseLifecycleEnvelope } from "./lifecycle-envelope.ts";
import { lifecycleActionId, requestLifecycleRemoval } from "./lifecycle-fence.ts";
import { admitTicket, reserveTicket } from "./lifecycle-tickets.ts";
import { parseManagedRemovalIntent } from "./managed-removal-intent.ts";
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
