/* Disconnected pure protocol; persistence and effects belong to a trusted owner.
 * The owner must atomically journal ticket admission together with lifecycle
 * fence intent before acknowledging or executing an effect. Two separate
 * journal writes leave a crash window. A repeated accepted ticket is not
 * permission to repeat an effect: inspect and reconcile its recorded intent.
 * Receipts, authorization, request completeness, client-side durable ticket
 * retention and incarnation uniqueness require a real integration. An
 * allocation reply lost before the client records its ticket leaves a reserved
 * ticket. There is no automatic expiry or reclaim protocol; enough such losses
 * exhaust capacity. This prototype is not ready for live integration. */
/* eslint-disable functional/prefer-immutable-types, functional/type-declaration-immutability */
import { createHash } from "node:crypto";
import { z } from "zod";
import { err, ok, type Result } from "../../lib/result.ts";

// These limits bound persisted state. An unresolved operation is never evicted.
export const maxOutstandingTickets = 64;
export const maxTerminalReceipts = 128;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const kind = z.enum(["register", "deploy", "restore", "remove", "purge"]);
const outcome = z.enum(["success", "failure", "cancelled", "superseded", "rejected"]);
const binding = { kind, digest };
const active = z.discriminatedUnion("phase", [
  z.object({ sequence, phase: z.literal("reserved") }).strict(),
  z.object({ sequence, phase: z.literal("accepted"), ...binding }).strict(),
]);
const receipt = z.object({ sequence, ...binding, outcome }).strict();
const schema = z.object({
  version: z.literal(1),
  app: z.string().regex(/^[a-z][a-z0-9-]*$/),
  incarnation: uuid,
  nextTicket: sequence,
  active: z.array(active).max(maxOutstandingTickets),
  receipts: z.array(receipt).max(maxTerminalReceipts),
}).strict().superRefine((value, ctx) => {
  const issued = [...value.active, ...value.receipts].map((item) => item.sequence);
  if (issued.some((item) => item >= value.nextTicket) || new Set(issued).size !== issued.length) {
    ctx.addIssue({ code: "custom", message: "invalid issued ticket identities" });
  }
});

// Descriptors contain only references, never config or secret values. Their
// authority and completeness must be established outside this prototype.
const descriptor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("register"), registrationGeneration: uuid }).strict(),
  z.object({ kind: z.literal("deploy"), planDigest: digest }).strict(),
  z.object({ kind: z.literal("restore"), planDigest: digest }).strict(),
  z.object({ kind: z.literal("remove"), ownershipGeneration: uuid }).strict(),
  z.object({ kind: z.literal("purge"), ownershipGeneration: uuid }).strict(),
]);
export type TicketState = z.infer<typeof schema>;
export type TicketDescriptor = z.infer<typeof descriptor>;
export type TicketOutcome = z.infer<typeof outcome>;
type TicketAdmission =
  | { readonly state: TicketState; readonly status: "new" | "accepted" }
  | { readonly state: TicketState; readonly status: "terminal"; readonly outcome: TicketOutcome };
type TicketLookup = { readonly status: "reserved" | "accepted" | "expired" } | { readonly status: "terminal"; readonly outcome: TicketOutcome };

/** No caller-supplied digest is accepted as the binding: canonicalize validated references here. */
const bind = (input: unknown) => {
  const parsed = descriptor.safeParse(input);
  if (!parsed.success) return err("invalid ticket descriptor");
  const d = parsed.data;
  const reference = d.kind === "register" ? d.registrationGeneration :
    d.kind === "deploy" || d.kind === "restore" ? d.planDigest : d.ownershipGeneration;
  const hash = createHash("sha256").update(JSON.stringify(["kayra-ticket-v1", d.kind, reference]), "utf8").digest("hex");
  return ok({ kind: d.kind, digest: hash });
};

/** Validate and snapshot journal input; the owner must persist each transition atomically. */
export const parseTicketState = (input: unknown) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err("invalid ticket state");
  parsed.data.active.forEach(Object.freeze);
  parsed.data.receipts.forEach(Object.freeze);
  Object.freeze(parsed.data.active);
  Object.freeze(parsed.data.receipts);
  return ok(Object.freeze(parsed.data));
};

/** Incarnation uniqueness and its durable allocator are the owner's responsibility. */
export const initialTicketState = (app: string, incarnation: string) => parseTicketState({
  version: 1, app, incarnation, nextTicket: 1, active: [], receipts: [],
});
const ticketId = (state: TicketState, n: number) => `${state.incarnation}:${String(n)}`;
const readId = (state: TicketState, id: string) => {
  const match = /^([0-9a-f-]+):([1-9][0-9]*)$/.exec(id);
  const n = Number(match?.[2]);
  if (match?.[1] !== state.incarnation || !Number.isSafeInteger(n) || n < 1 || n >= state.nextTicket) return err("invalid or unissued ticket");
  return ok(n);
};

/** Allocation does not authorize or perform an effect. Persist before returning its ID. */
export const reserveTicket = (input: unknown) => {
  const state = parseTicketState(input);
  if (!state.ok) return state;
  if (state.value.active.length >= maxOutstandingTickets || state.value.nextTicket >= Number.MAX_SAFE_INTEGER) return err("ticket capacity or sequence exhausted");
  const n = state.value.nextTicket;
  const next = parseTicketState({ ...state.value, nextTicket: n + 1, active: [...state.value.active, { sequence: n, phase: "reserved" }] });
  return next.ok ? ok({ state: next.value, ticket: ticketId(next.value, n) }) : next;
};

/** Admission is a correlation primitive, not authentication or an effect authorization. */
export const admitTicket = (input: unknown, id: string, request: unknown): Result<TicketAdmission, string> => {
  const state = parseTicketState(input);
  if (!state.ok) return state;
  const n = readId(state.value, id);
  if (!n.ok) return n;
  const b = bind(request);
  if (!b.ok) return b;
  const held = state.value.active.find((item) => item.sequence === n.value);
  const prior = state.value.receipts.find((item) => item.sequence === n.value);
  if (held === undefined && prior === undefined) return err("ticket receipt expired");
  if (prior !== undefined) {
    return prior.kind === b.value.kind && prior.digest === b.value.digest
      ? ok({ state: state.value, status: "terminal" as const, outcome: prior.outcome }) : err("ticket descriptor conflict");
  }
  if (held?.phase === "accepted") {
    return held.kind === b.value.kind && held.digest === b.value.digest
      ? ok({ state: state.value, status: "accepted" as const }) : err("ticket descriptor conflict");
  }
  const next = parseTicketState({ ...state.value, active: state.value.active.map((item) => item.sequence === n.value ? { sequence: n.value, phase: "accepted", ...b.value } : item) });
  return next.ok ? ok({ state: next.value, status: "new" as const }) : next;
};

/** Only a trusted reconciler may record an outcome after establishing it. */
export const completeTicket = (input: unknown, id: string, result: TicketOutcome) => {
  const state = parseTicketState(input);
  if (!state.ok) return state;
  const n = readId(state.value, id);
  if (!n.ok) return n;
  const checked = outcome.safeParse(result);
  if (!checked.success) return err("invalid terminal outcome");
  const held = state.value.active.find((item) => item.sequence === n.value);
  const prior = state.value.receipts.find((item) => item.sequence === n.value);
  if (prior !== undefined) return prior.outcome === checked.data ? ok(state.value) : err("ticket outcome conflict");
  if (held?.phase !== "accepted") return err("ticket is not accepted");
  // Evict only terminal receipts, never active or uncertain operations.
  return parseTicketState({
    ...state.value,
    active: state.value.active.filter((item) => item.sequence !== n.value),
    receipts: [...state.value.receipts, { sequence: n.value, kind: held.kind, digest: held.digest, outcome: checked.data }].slice(-maxTerminalReceipts),
  });
};

/** A reserved but never accepted ticket may be closed; a late submission is rejected.
 * This transition is not an automatic expiry or lost-allocation recovery protocol. */
export const retireUnusedTicket = (input: unknown, id: string) => {
  const state = parseTicketState(input);
  if (!state.ok) return state;
  const n = readId(state.value, id);
  if (!n.ok) return n;
  const held = state.value.active.find((item) => item.sequence === n.value);
  if (held?.phase !== "reserved") return err("ticket is not an unused reservation");
  return parseTicketState({ ...state.value, active: state.value.active.filter((item) => item.sequence !== n.value) });
};

/** A missing issued ticket is expired, never available for reuse. */
export const lookupTicket = (input: unknown, id: string): Result<TicketLookup, string> => {
  const state = parseTicketState(input);
  if (!state.ok) return state;
  const n = readId(state.value, id);
  if (!n.ok) return n;
  const held = state.value.active.find((item) => item.sequence === n.value);
  const prior = state.value.receipts.find((item) => item.sequence === n.value);
  if (held !== undefined) return ok({ status: held.phase });
  if (prior !== undefined) return ok({ status: "terminal" as const, outcome: prior.outcome });
  return ok({ status: "expired" as const });
};
