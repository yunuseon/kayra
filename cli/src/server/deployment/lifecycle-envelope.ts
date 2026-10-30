/* Disconnected parser only: it neither owns a journal nor authorizes effects.
 * Accepted queued requests are deliberately unsupported, so this cannot replace
 * the live queue. An owner must atomically persist all participating transitions
 * and separately establish trusted authority, completeness and runtime evidence. */
/* eslint-disable functional/prefer-immutable-types */
import { z } from "zod";
import { err, ok } from "../../lib/result.ts";
import { lifecycleActionId, parseLifecycleFence } from "./lifecycle-fence.ts";
import { admitTicket, parseTicketState } from "./lifecycle-tickets.ts";

// Snapshot only narrowly defined references; the ticket module independently
// validates and hashes them, so a mismatch between the schemas fails closed.
// Registration and ownership generations are independent references, not app
// incarnation IDs. This parser cannot authenticate either without registries.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const descriptor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("register"), registrationGeneration: uuid }).strict(),
  z.object({ kind: z.literal("deploy"), planDigest: digest }).strict(),
  z.object({ kind: z.literal("restore"), planDigest: digest }).strict(),
  z.object({ kind: z.literal("remove"), ownershipGeneration: uuid }).strict(),
  z.object({ kind: z.literal("purge"), ownershipGeneration: uuid }).strict(),
]);
const shape = z.object({
  version: z.literal(1),
  // A durable app index and monotonic owner are mandatory: this marker alone
  // cannot authenticate history or detect that both it and the fence were reset.
  created: z.boolean(),
  fence: z.unknown(),
  tickets: z.unknown(),
  operations: z.array(z.object({ ticket: z.string().max(80), action: z.string().max(80), descriptor }).strict()).max(2),
}).strict();

/** Validate every in-flight action and ticket against the same app incarnation. */
export const parseLifecycleEnvelope = (input: unknown) => {
  const parsed = shape.safeParse(input);
  if (!parsed.success) return err("invalid lifecycle envelope");
  const tickets = parseTicketState(parsed.data.tickets);
  if (!tickets.ok) return err("invalid lifecycle envelope");
  const fence = parsed.data.fence === null ? ok(null) : parseLifecycleFence(parsed.data.fence);
  if (!fence.ok) return err("invalid lifecycle envelope");
  if (parsed.data.created !== (fence.value !== null) || (fence.value === null && tickets.value.receipts.length !== 0)) return err("invalid lifecycle envelope");
  if (fence.value !== null && (fence.value.app !== tickets.value.app || fence.value.generation !== tickets.value.incarnation)) return err("invalid lifecycle envelope");

  const current = fence.value?.lifecycle;
  const action = current !== undefined && "active" in current ? current.active : null;
  const expected = [
    ...(action === null || fence.value === null ? [] : [{ id: lifecycleActionId(fence.value, action.sequence), kind: action.kind }]),
    ...(current !== undefined && fence.value !== null && (current.phase === "removal-requested" || current.phase === "removing")
      ? [{ id: lifecycleActionId(fence.value, current.removal), kind: "remove" as const }] : []),
    ...(current?.phase === "purging" && fence.value !== null ? [{ id: lifecycleActionId(fence.value, current.purge), kind: "purge" as const }] : []),
  ];
  const operations = parsed.data.operations;
  const accepted = tickets.value.active.filter((item) => item.phase === "accepted");
  if (operations.length !== expected.length || operations.length !== accepted.length ||
    new Set(operations.map((item) => item.action)).size !== operations.length ||
    new Set(operations.map((item) => item.ticket)).size !== operations.length) return err("invalid lifecycle envelope");

  const consistent = operations.every((operation) => {
    const target = expected.find((item) => item.id === operation.action);
    if (target?.kind !== operation.descriptor.kind) return false;
    const admitted = admitTicket(tickets.value, operation.ticket, operation.descriptor);
    return admitted.ok && admitted.value.status === "accepted";
  });
  if (!consistent) return err("invalid lifecycle envelope");
  operations.forEach((operation) => { Object.freeze(operation.descriptor); Object.freeze(operation); });
  return ok(Object.freeze({ version: 1 as const, created: parsed.data.created, fence: fence.value, tickets: tickets.value, operations: Object.freeze(operations) }));
};
