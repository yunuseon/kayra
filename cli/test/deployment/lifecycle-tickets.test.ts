import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Result } from "../../src/lib/result.ts";
import {
  admitTicket, completeTicket, initialTicketState, lookupTicket, maxOutstandingTickets,
  maxTerminalReceipts, parseTicketState, reserveTicket, retireUnusedTicket,
} from "../../src/server/deployment/lifecycle-tickets.ts";

const incarnation = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const descriptor = { kind: "deploy", planDigest: "a".repeat(64) } as const;
// eslint-disable-next-line functional/prefer-immutable-types -- the helper accepts varied result shapes
const must = <T>(r: Result<T, string>): T => { if (!r.ok) throw new Error(r.error); return r.value; };

test("lost responses return the same accepted or terminal operation and reject changed payloads", () => {
  const reserved = must(reserveTicket(must(initialTicketState("shop", incarnation))));
  const admitted = must(admitTicket(reserved.state, reserved.ticket, descriptor));
  assert.equal(admitted.status, "new");
  const retried = must(admitTicket(admitted.state, reserved.ticket, descriptor));
  assert.equal(retried.status, "accepted");
  assert.equal(admitTicket(admitted.state, reserved.ticket, { ...descriptor, planDigest: "b".repeat(64) }).ok, false);
  const done = must(completeTicket(admitted.state, reserved.ticket, "success"));
  assert.deepEqual(must(lookupTicket(done, reserved.ticket)), { status: "terminal", outcome: "success" });
  assert.equal(must(admitTicket(done, reserved.ticket, descriptor)).status, "terminal");
  assert.deepEqual(must(completeTicket(done, reserved.ticket, "success")), done);
  assert.equal(completeTicket(done, reserved.ticket, "failure").ok, false);
  assert.equal(admitTicket(done, reserved.ticket, { kind: "restore", planDigest: descriptor.planDigest }).ok, false);
});

test("only unused reservations retire, and their late submissions cannot start work", () => {
  const reserved = must(reserveTicket(must(initialTicketState("shop", incarnation))));
  const retired = must(retireUnusedTicket(reserved.state, reserved.ticket));
  assert.deepEqual(must(lookupTicket(retired, reserved.ticket)), { status: "expired" });
  assert.equal(admitTicket(retired, reserved.ticket, descriptor).ok, false);
  const accepted = must(admitTicket(reserved.state, reserved.ticket, descriptor));
  assert.equal(retireUnusedTicket(accepted.state, reserved.ticket).ok, false);
  assert.equal(admitTicket(accepted.state, `${other}:1`, descriptor).ok, false);
  assert.equal(admitTicket(accepted.state, `${incarnation}:2`, descriptor).ok, false);
  assert.equal(admitTicket(accepted.state, `${incarnation}:01`, descriptor).ok, false);
});

test("evicted terminal receipts cannot be readmitted", () => {
  // eslint-disable-next-line functional/no-let -- simulate successive durable operations
  let state = must(initialTicketState("shop", incarnation));
  // eslint-disable-next-line functional/no-let -- retain the first identity through compaction
  let first = "";
  // eslint-disable-next-line functional/no-let -- exercise more receipts than the retention bound
  for (let index = 0; index <= maxTerminalReceipts; index++) {
    const reserved = must(reserveTicket(state));
    if (index === 0) first = reserved.ticket;
    const admitted = must(admitTicket(reserved.state, reserved.ticket, descriptor));
    state = must(completeTicket(admitted.state, reserved.ticket, "success"));
  }
  assert.equal(state.receipts.length, maxTerminalReceipts);
  assert.deepEqual(must(lookupTicket(state, first)), { status: "expired" });
  assert.equal(admitTicket(state, first, descriptor).ok, false);
  assert.equal(completeTicket(state, first, "success").ok, false);
});

test("outstanding capacity, unsafe sequences and malformed state fail closed", () => {
  // eslint-disable-next-line functional/no-let -- fill bounded durable reservations
  let state = must(initialTicketState("shop", incarnation));
  // eslint-disable-next-line functional/no-let -- exercise the outstanding bound
  for (let index = 0; index < maxOutstandingTickets; index++) state = must(reserveTicket(state)).state;
  assert.equal(reserveTicket(state).ok, false);
  const exhausted = must(parseTicketState({ ...state, active: [], nextTicket: Number.MAX_SAFE_INTEGER }));
  assert.equal(reserveTicket(exhausted).ok, false);
  assert.equal(parseTicketState({ ...state, nextTicket: Number.MAX_SAFE_INTEGER + 1 }).ok, false);
  assert.equal(parseTicketState({ ...state, active: [...state.active, state.active[0]] }).ok, false);
  assert.equal(parseTicketState({ ...state, active: [{ phase: "reserved", sequence: state.nextTicket }] }).ok, false);
});

test("descriptors accept only explicit references and do not persist secret values", () => {
  const reservation = must(reserveTicket(must(initialTicketState("shop", incarnation))));
  assert.equal(admitTicket(reservation.state, reservation.ticket, { ...descriptor, secret: "plaintext" }).ok, false);
  assert.equal(admitTicket(reservation.state, reservation.ticket, { kind: "register", registrationGeneration: "plaintext" }).ok, false);
  assert.equal(admitTicket(reservation.state, reservation.ticket, { kind: "deploy", digest: "a".repeat(64) }).ok, false);
  const admitted = must(admitTicket(reservation.state, reservation.ticket, { kind: "register", registrationGeneration: other }));
  assert.equal(JSON.stringify(admitted.state).includes(other), false);
});

test("lost allocation replies occupy capacity without an automatic reclaim protocol", () => {
  // eslint-disable-next-line functional/no-let -- model replies lost before a client records a ticket
  let state = must(initialTicketState("shop", incarnation));
  // eslint-disable-next-line functional/no-let -- each allocation consumes one persistent slot
  for (let index = 0; index < maxOutstandingTickets; index++) state = must(reserveTicket(state)).state;
  assert.equal(state.active.length, maxOutstandingTickets);
  assert.equal(reserveTicket(state).ok, false);
  assert.ok(state.active.every((entry) => entry.phase === "reserved"));
});

test("an unresolved accepted ticket survives terminal receipt churn", () => {
  const first = must(reserveTicket(must(initialTicketState("shop", incarnation))));
  const accepted = must(admitTicket(first.state, first.ticket, descriptor));
  // eslint-disable-next-line functional/no-let -- simulate terminal receipts while the first effect is unresolved
  let state = accepted.state;
  // eslint-disable-next-line functional/no-let -- exceed the terminal receipt bound
  for (let index = 0; index <= maxTerminalReceipts; index++) {
    const next = must(reserveTicket(state));
    const admitted = must(admitTicket(next.state, next.ticket, descriptor));
    state = must(completeTicket(admitted.state, next.ticket, "success"));
  }
  assert.deepEqual(must(lookupTicket(state, first.ticket)), { status: "accepted" });
  assert.equal(must(admitTicket(state, first.ticket, descriptor)).status, "accepted");
  assert.equal(retireUnusedTicket(state, first.ticket).ok, false);
});

test("each descriptor kind binds its specific validated reference", () => {
  const requests = [
    { kind: "register", registrationGeneration: other },
    { kind: "deploy", planDigest: "a".repeat(64) },
    { kind: "restore", planDigest: "a".repeat(64) },
    { kind: "remove", ownershipGeneration: other },
    { kind: "purge", ownershipGeneration: other },
  ] as const;
  requests.forEach((request) => {
    const reservation = must(reserveTicket(must(initialTicketState("shop", incarnation))));
    const admitted = must(admitTicket(reservation.state, reservation.ticket, request));
    assert.equal(must(admitTicket(admitted.state, reservation.ticket, request)).status, "accepted");
    const changed = request.kind === "register" ? { ...request, registrationGeneration: incarnation } :
      request.kind === "deploy" || request.kind === "restore" ? { ...request, planDigest: "b".repeat(64) } :
        { ...request, ownershipGeneration: incarnation };
    assert.equal(admitTicket(admitted.state, reservation.ticket, changed).ok, false);
  });
});

test("last safe reservation preserves its identity and exhausts the sequence", () => {
  const state = must(parseTicketState({ ...must(initialTicketState("shop", incarnation)), nextTicket: Number.MAX_SAFE_INTEGER - 1 }));
  const final = must(reserveTicket(state));
  assert.equal(final.ticket, `${incarnation}:${String(Number.MAX_SAFE_INTEGER - 1)}`);
  assert.equal(reserveTicket(final.state).ok, false);
  assert.equal(must(admitTicket(final.state, final.ticket, descriptor)).status, "new");
});
