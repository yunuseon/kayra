import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JournalValue } from "../../src/server/deployment/journal.ts";
import { openLifecycleEnvelopeStore } from "../../src/server/deployment/lifecycle-envelope-store.ts";
import { parseLifecycleEnvelope } from "../../src/server/deployment/lifecycle-envelope.ts";
import { beginLifecycleRegistration, lifecycleActionId, settleLifecycleWork } from "../../src/server/deployment/lifecycle-fence.ts";
import { admitTicket, completeTicket, reserveTicket } from "../../src/server/deployment/lifecycle-tickets.ts";

const incarnation = "11111111-1111-4111-8111-111111111111";
const registration = "22222222-2222-4222-8222-222222222222";

test("concurrent same-ticket submissions persist one combined intent and return reconciliation on retry", async () => {
  // eslint-disable-next-line functional/no-let -- records the simulated durable snapshot
  let value: JournalValue | undefined;
  // eslint-disable-next-line functional/no-let -- count completed writes
  let writes = 0;
  const journal = { read: () => Promise.resolve(value), write: (next: JournalValue) => { value = structuredClone(next); writes++; return Promise.resolve(); } };
  const store = openLifecycleEnvelopeStore(journal);
  await store.initialize("shop", incarnation);
  const ticket = await store.reserveRegistration();
  const [first, retry] = await Promise.all([store.submitRegistration(ticket, registration), store.submitRegistration(ticket, registration)]);
  assert.equal(first.status, "new");
  assert.deepEqual(retry, { status: "reconcile", actionId: first.actionId });
  assert.equal(writes, 3); // initialize, reserve, and one combined ticket/fence submission
  const saved = parseLifecycleEnvelope(value);
  assert.equal(saved.ok, true);
  if (saved.value.fence === null) throw new Error("missing combined intent");
  assert.equal(saved.value.fence.lifecycle.phase, "registering");
  assert.deepEqual(saved.value.operations.map((item) => item.ticket), [ticket]);
  assert.equal(saved.value.tickets.active[0]?.phase, "accepted");
  await assert.rejects(store.submitRegistration(ticket, incarnation), /conflict/);
  await assert.rejects(store.reserveRegistration(), /already/);
  assert.equal(writes, 3);
});

test("lost submission acknowledgement poisons the owner; reopen yields reconciliation rather than new permission", async () => {
  // eslint-disable-next-line functional/no-let -- simulated committed journal state
  let value: JournalValue | undefined;
  // eslint-disable-next-line functional/no-let -- lose only the submission response
  let lose = false;
  const journal = { read: () => Promise.resolve(value), write: (next: JournalValue) => { value = structuredClone(next); return lose ? Promise.reject(new Error("lost acknowledgement")) : Promise.resolve(); } };
  const store = openLifecycleEnvelopeStore(journal);
  await store.initialize("shop", incarnation);
  const ticket = await store.reserveRegistration();
  lose = true;
  await assert.rejects(store.submitRegistration(ticket, registration), /lost acknowledgement/);
  await assert.rejects(store.read(), /uncertain/);
  await assert.rejects(store.submitRegistration(ticket, registration), /uncertain/);
  const reopened = openLifecycleEnvelopeStore({ read: () => Promise.resolve(value), write: () => Promise.resolve() });
  assert.deepEqual(await reopened.submitRegistration(ticket, registration), { status: "reconcile", actionId: `${incarnation}:1` });
  await assert.rejects(reopened.submitRegistration(ticket, incarnation), /conflict/);
});

test("corrupt records, identity conflicts and competing reservations fail without writing", async () => {
  // eslint-disable-next-line functional/no-let -- simulated journal value
  let value: JournalValue | undefined;
  // eslint-disable-next-line functional/no-let -- count writes
  let writes = 0;
  const journal = { read: () => Promise.resolve(value), write: (next: JournalValue) => { value = structuredClone(next); writes++; return Promise.resolve(); } };
  const store = openLifecycleEnvelopeStore(journal);
  await store.initialize("shop", incarnation);
  await assert.rejects(store.initialize("other", incarnation), /already/);
  const first = await store.reserveRegistration();
  const second = await store.reserveRegistration();
  await store.submitRegistration(first, registration);
  const before = writes;
  await assert.rejects(store.submitRegistration(second, registration), /already/);
  assert.equal(writes, before);
  value = { version: 1, created: true, fence: null, tickets: {}, operations: [] };
  await assert.rejects(store.read(), /invalid/);
  await assert.rejects(store.submitRegistration(first, registration), /invalid/);
  assert.equal(writes, before);
});

test("an accepted later registration update is not an initial registration retry", async () => {
  // eslint-disable-next-line functional/no-let -- simulated journal snapshot
  let value: JournalValue | undefined;
  // eslint-disable-next-line functional/no-let -- count writes
  let writes = 0;
  const journal = { read: () => Promise.resolve(value), write: (next: JournalValue) => { value = structuredClone(next); writes++; return Promise.resolve(); } };
  const store = openLifecycleEnvelopeStore(journal);
  await store.initialize("shop", incarnation);
  const initialTicket = await store.reserveRegistration();
  const initial = await store.submitRegistration(initialTicket, registration);
  const envelope = parseLifecycleEnvelope(value);
  if (!envelope.ok || envelope.value.fence === null) throw new Error("expected initial registration");
  const ready = settleLifecycleWork(envelope.value.fence, initial.actionId);
  const completed = completeTicket(envelope.value.tickets, initialTicket, "success");
  if (!ready.ok || !completed.ok) throw new Error("expected settled registration");
  const updated = beginLifecycleRegistration(ready.value);
  const reserved = reserveTicket(completed.value);
  if (!updated.ok || !reserved.ok) throw new Error("expected update reservation");
  const descriptor = { kind: "register", registrationGeneration: registration } as const;
  const accepted = admitTicket(reserved.value.state, reserved.value.ticket, descriptor);
  if (!accepted.ok) throw new Error("expected accepted update");
  value = { version: 1, created: true, fence: updated.value, tickets: accepted.value.state, operations: [{ ticket: reserved.value.ticket, action: lifecycleActionId(updated.value, 2), descriptor }] };
  assert.equal(parseLifecycleEnvelope(value).ok, true);
  const before = writes;
  await assert.rejects(store.submitRegistration(reserved.value.ticket, registration), /not an initial registration/);
  assert.equal(writes, before);
});
