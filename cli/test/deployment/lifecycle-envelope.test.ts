/* Test helpers create known populated fixture arrays. */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Result } from "../../src/lib/result.ts";
import { parseLifecycleEnvelope } from "../../src/server/deployment/lifecycle-envelope.ts";
import { beginLifecycleRegistration, beginLifecycleWork, beginRegistration, completeLifecycleRemoval, lifecycleActionId, requestLifecycleRemoval, settleLifecycleWork, startLifecyclePurge, startLifecycleRemoval } from "../../src/server/deployment/lifecycle-fence.ts";
import { admitTicket, completeTicket, initialTicketState, reserveTicket, retireUnusedTicket } from "../../src/server/deployment/lifecycle-tickets.ts";

const must = <T>(r: Result<T, string>): T => { if (!r.ok) throw new Error(r.error); return r.value; };
const appEpoch = "11111111-1111-4111-8111-111111111111";
const generation = "22222222-2222-4222-8222-222222222222";
const registration = { kind: "register", registrationGeneration: generation } as const;
const deploy = { kind: "deploy", planDigest: "a".repeat(64) } as const;
const remove = { kind: "remove", ownershipGeneration: generation } as const;
const purge = { kind: "purge", ownershipGeneration: generation } as const;
const initial = () => {
  const fence = must(beginRegistration("shop", appEpoch));
  const ticket = must(reserveTicket(must(initialTicketState("shop", appEpoch))));
  const accepted = must(admitTicket(ticket.state, ticket.ticket, registration));
  return { version: 1 as const, created: true, fence, tickets: accepted.state, operations: [{ ticket: ticket.ticket, action: lifecycleActionId(fence, 1), descriptor: registration }] };
};
const ready = () => {
  const start = initial();
  return { version: 1 as const, created: true, fence: must(settleLifecycleWork(start.fence, start.operations[0]!.action)), tickets: must(completeTicket(start.tickets, start.operations[0]!.ticket, "success")), operations: [] };
};
const inFlight = () => {
  const start = ready();
  const fence = must(beginLifecycleWork(start.fence, "deploy"));
  const ticket = must(reserveTicket(start.tickets));
  return { version: 1 as const, created: true, fence, tickets: must(admitTicket(ticket.state, ticket.ticket, deploy)).state, operations: [{ ticket: ticket.ticket, action: lifecycleActionId(fence, 2), descriptor: deploy }] };
};
const removalRequested = () => {
  const start = inFlight();
  const fence = must(requestLifecycleRemoval(start.fence));
  const ticket = must(reserveTicket(start.tickets));
  return { version: 1 as const, created: true, fence, tickets: must(admitTicket(ticket.state, ticket.ticket, remove)).state, operations: [...start.operations, { ticket: ticket.ticket, action: lifecycleActionId(fence, 3), descriptor: remove }] };
};

test("matches registration, registration updates and idle states", () => {
  const start = initial();
  assert.equal(parseLifecycleEnvelope(start).ok, true);
  const idle = ready();
  assert.equal(parseLifecycleEnvelope(idle).ok, true);
  const fence = must(beginLifecycleRegistration(idle.fence));
  const ticket = must(reserveTicket(idle.tickets));
  const update = { version: 1, created: true, fence, tickets: must(admitTicket(ticket.state, ticket.ticket, registration)).state, operations: [{ ticket: ticket.ticket, action: lifecycleActionId(fence, 2), descriptor: registration }] };
  const parsed = must(parseLifecycleEnvelope(update));
  assert.equal(Reflect.set(parsed.operations[0]!.descriptor, "kind", "deploy"), false);
  assert.equal(parseLifecycleEnvelope({ ...update, operations: [{ ...update.operations[0], descriptor: { ...registration, secret: "plaintext" } }] }).ok, false);
});

test("matches both in-flight actions while removal waits, and removal and purge separately", () => {
  const waiting = removalRequested();
  assert.equal(parseLifecycleEnvelope(waiting).ok, true);
  const settled = must(settleLifecycleWork(waiting.fence, waiting.operations[0]!.action));
  const tickets = must(completeTicket(waiting.tickets, waiting.operations[0]!.ticket, "success"));
  const removing = must(startLifecycleRemoval(settled, ["shop_db"]));
  assert.equal(parseLifecycleEnvelope({ ...waiting, fence: removing, tickets, operations: [waiting.operations[1]] }).ok, true);
  const removed = must(completeLifecycleRemoval(removing, waiting.operations[1]!.action));
  const completed = must(completeTicket(tickets, waiting.operations[1]!.ticket, "success"));
  const ticket = must(reserveTicket(completed));
  const purging = must(startLifecyclePurge(removed, waiting.operations[1]!.action));
  const purgeEnvelope = { version: 1, created: true, fence: purging, tickets: must(admitTicket(ticket.state, ticket.ticket, purge)).state, operations: [{ ticket: ticket.ticket, action: lifecycleActionId(purging, 4), descriptor: purge }] };
  assert.equal(parseLifecycleEnvelope(purgeEnvelope).ok, true);
});

test("rejects missing, duplicated, wrong actions and altered descriptors", () => {
  const value = removalRequested();
  assert.equal(parseLifecycleEnvelope({ ...value, operations: [value.operations[0]] }).ok, false);
  assert.equal(parseLifecycleEnvelope({ ...value, operations: [value.operations[0], value.operations[0]] }).ok, false);
  assert.equal(parseLifecycleEnvelope({ ...value, operations: [value.operations[0], { ...value.operations[1], ticket: value.operations[0]!.ticket }] }).ok, false);
  assert.equal(parseLifecycleEnvelope({ ...value, operations: [value.operations[0], { ...value.operations[1], action: `${appEpoch}:999` }] }).ok, false);
  assert.equal(parseLifecycleEnvelope({ ...value, operations: [{ ...value.operations[0], descriptor: { ...deploy, planDigest: "b".repeat(64) } }, value.operations[1]] }).ok, false);
});

test("rejects other app or incarnation, unexplained tickets and null-fence effects", () => {
  const value = inFlight();
  assert.equal(parseLifecycleEnvelope({ ...value, tickets: { ...value.tickets, app: "other" } }).ok, false);
  assert.equal(parseLifecycleEnvelope({ ...value, tickets: { ...value.tickets, incarnation: generation } }).ok, false);
  assert.equal(parseLifecycleEnvelope({ ...value, fence: null }).ok, false);
  assert.equal(parseLifecycleEnvelope({ version: 1, created: true, fence: null, tickets: value.tickets, operations: [] }).ok, false);
  const registered = ready();
  assert.equal(parseLifecycleEnvelope({ ...registered, fence: null }).ok, false);
  assert.equal(parseLifecycleEnvelope({ ...registered, created: false, fence: null }).ok, false);
  assert.equal(parseLifecycleEnvelope({ version: 1, created: false, fence: null, tickets: must(initialTicketState("shop", appEpoch)), operations: [] }).ok, true);
});

test("reserved, terminal or expired tickets cannot stand for active effects", () => {
  const start = ready();
  const fence = must(beginLifecycleWork(start.fence, "deploy"));
  const ticket = must(reserveTicket(start.tickets));
  const operation = { ticket: ticket.ticket, action: lifecycleActionId(fence, 2), descriptor: deploy };
  assert.equal(parseLifecycleEnvelope({ version: 1, created: true, fence, tickets: ticket.state, operations: [operation] }).ok, false);
  const accepted = must(admitTicket(ticket.state, ticket.ticket, deploy)).state;
  const terminal = must(completeTicket(accepted, ticket.ticket, "success"));
  assert.equal(parseLifecycleEnvelope({ version: 1, created: true, fence, tickets: terminal, operations: [operation] }).ok, false);
  const expired = must(retireUnusedTicket(ticket.state, ticket.ticket));
  assert.equal(parseLifecycleEnvelope({ version: 1, created: true, fence, tickets: expired, operations: [operation] }).ok, false);
});
