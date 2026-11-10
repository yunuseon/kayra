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
  if (!envelope.ok || envelope.value.fence === null || initial.status === "terminal") throw new Error("expected initial registration");
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

test("only matching authoritative applied evidence atomically completes initial registration", async () => {
  // eslint-disable-next-line functional/no-let -- simulated journal snapshot
  let value: JournalValue | undefined;
  // eslint-disable-next-line functional/no-let -- count writes
  let writes = 0;
  // eslint-disable-next-line functional/no-let -- choose observer evidence for each attempt
  let mode = "unknown";
  const journal = { read: () => Promise.resolve(value), write: (next: JournalValue) => { value = structuredClone(next); writes++; return Promise.resolve(); } };
  const store = openLifecycleEnvelopeStore(journal, (expected) => {
    assert.deepEqual(expected, { app: "shop", incarnation, actionId: `${incarnation}:1`, registrationGeneration: registration });
    assert.equal(Object.isFrozen(expected), true);
    if (mode === "error") return Promise.reject(new Error("unavailable"));
    if (mode === "wrong-app") return Promise.resolve({ ...expected, app: "other", status: "applied" });
    if (mode === "wrong-incarnation") return Promise.resolve({ ...expected, incarnation: registration, status: "applied" });
    if (mode === "wrong-action") return Promise.resolve({ ...expected, actionId: `${incarnation}:2`, status: "applied" });
    if (mode === "wrong-generation") return Promise.resolve({ ...expected, registrationGeneration: incarnation, status: "applied" });
    if (mode === "extra") return Promise.resolve({ ...expected, status: "applied", secret: "not allowed" });
    return Promise.resolve({ ...expected, status: mode });
  });
  await store.initialize("shop", incarnation);
  const ticket = await store.reserveRegistration();
  await store.submitRegistration(ticket, registration);
  const pendingState = structuredClone(value);
  const priorWrites = writes;
  for (const next of ["unknown", "not-applied", "error", "wrong-app", "wrong-incarnation", "wrong-action", "wrong-generation", "extra"]) {
    mode = next;
    assert.deepEqual(await store.reconcileRegistration(ticket, registration), { status: "pending" });
    assert.deepEqual(value, pendingState);
    assert.equal(writes, priorWrites);
  }
  mode = "applied";
  assert.deepEqual(await store.reconcileRegistration(ticket, registration), { status: "verified" });
  assert.equal(writes, priorWrites + 1);
  const finalState = parseLifecycleEnvelope(value);
  if (!finalState.ok || finalState.value.fence === null) throw new Error("invalid completed registration");
  assert.deepEqual(finalState.value.fence.lifecycle, { phase: "registered", active: null });
  assert.equal(finalState.value.operations.length, 0);
  assert.deepEqual(finalState.value.tickets.receipts.map((receipt) => receipt.outcome), ["success"]);
  assert.deepEqual(await store.reconcileRegistration(ticket, registration), { status: "terminal", outcome: "success" });
  assert.deepEqual(await store.submitRegistration(ticket, registration), { status: "terminal", outcome: "success" });
  await assert.rejects(store.reconcileRegistration(ticket, incarnation), /conflict/);
  assert.equal(writes, priorWrites + 1);
});

test("unavailable observer never settles and uncertain completion requires reopening", async () => {
  // eslint-disable-next-line functional/no-let -- simulated journal snapshot
  let value: JournalValue | undefined;
  // eslint-disable-next-line functional/no-let -- simulate a committed write whose acknowledgement is lost
  let lose = false;
  const journal = { read: () => Promise.resolve(value), write: (next: JournalValue) => { value = structuredClone(next); return lose ? Promise.reject(new Error("lost acknowledgement")) : Promise.resolve(); } };
  const setup = openLifecycleEnvelopeStore(journal);
  await setup.initialize("shop", incarnation);
  const ticket = await setup.reserveRegistration();
  await setup.submitRegistration(ticket, registration);
  assert.deepEqual(await setup.reconcileRegistration(ticket, registration), { status: "pending" });
  const observer = (expected: { readonly app: string; readonly incarnation: string; readonly actionId: string; readonly registrationGeneration: string }) => Promise.resolve({ ...expected, status: "applied" });
  const owner = openLifecycleEnvelopeStore({ read: () => Promise.resolve(value), write: journal.write }, observer);
  lose = true;
  await assert.rejects(owner.reconcileRegistration(ticket, registration), /lost acknowledgement/);
  await assert.rejects(owner.read(), /uncertain/);
  const reopened = openLifecycleEnvelopeStore({ read: () => Promise.resolve(value), write: () => Promise.resolve() }, observer);
  assert.deepEqual(await reopened.reconcileRegistration(ticket, registration), { status: "terminal", outcome: "success" });
});

test("a completion write failure before commit keeps intent fenced until reopened and re-observed", async () => {
  // eslint-disable-next-line functional/no-let -- simulated durable journal state
  let value: JournalValue | undefined;
  // eslint-disable-next-line functional/no-let -- control a pre-commit write failure
  let fail = false;
  // eslint-disable-next-line functional/no-let -- count read-only observations
  let observations = 0;
  const journal = { read: () => Promise.resolve(value), write: (next: JournalValue) => {
    if (fail) return Promise.reject(new Error("write failed before commit"));
    value = structuredClone(next);
    return Promise.resolve();
  } };
  const observer = (expected: { readonly app: string; readonly incarnation: string; readonly actionId: string; readonly registrationGeneration: string }) => {
    observations++;
    return Promise.resolve({ ...expected, status: "applied" });
  };
  const store = openLifecycleEnvelopeStore(journal, observer);
  await store.initialize("shop", incarnation);
  const ticket = await store.reserveRegistration();
  await store.submitRegistration(ticket, registration);
  const pending = structuredClone(value);
  fail = true;
  await assert.rejects(store.reconcileRegistration(ticket, registration), /before commit/);
  assert.deepEqual(value, pending);
  await assert.rejects(store.read(), /uncertain/);
  fail = false;
  const reopened = openLifecycleEnvelopeStore({ read: journal.read, write: journal.write }, observer);
  assert.deepEqual(await reopened.reconcileRegistration(ticket, registration), { status: "verified" });
  assert.deepEqual(await reopened.reconcileRegistration(ticket, registration), { status: "terminal", outcome: "success" });
  assert.equal(observations, 2);
});

test("concurrent reconciliation observes and commits once, then returns the historical receipt", async () => {
  // eslint-disable-next-line functional/no-let -- simulated journal contents
  let value: JournalValue | undefined;
  // eslint-disable-next-line functional/no-let -- count persisted transitions
  let writes = 0;
  // eslint-disable-next-line functional/no-let -- count read-only observations
  let observations = 0;
  const journal = { read: () => Promise.resolve(value), write: (next: JournalValue) => { value = structuredClone(next); writes++; return Promise.resolve(); } };
  const observer = (expected: { readonly app: string; readonly incarnation: string; readonly actionId: string; readonly registrationGeneration: string }) => {
    observations++;
    return Promise.resolve({ ...expected, status: "applied" });
  };
  const store = openLifecycleEnvelopeStore(journal, observer);
  await store.initialize("shop", incarnation);
  const ticket = await store.reserveRegistration();
  await store.submitRegistration(ticket, registration);
  const before = writes;
  const [first, second] = await Promise.all([store.reconcileRegistration(ticket, registration), store.reconcileRegistration(ticket, registration)]);
  assert.deepEqual(first, { status: "verified" });
  assert.deepEqual(second, { status: "terminal", outcome: "success" });
  assert.equal(observations, 1);
  assert.equal(writes, before + 1);
});

test("a timed-out observation leaves intent pending and a later attempt can verify it", async () => {
  // eslint-disable-next-line functional/no-let -- simulated durable state
  let value: JournalValue | undefined;
  // eslint-disable-next-line functional/no-let -- first observation remains outstanding until explicitly released
  let calls = 0;
  const late = Promise.withResolvers<unknown>();
  const aborted = Promise.withResolvers<undefined>();
  const store = openLifecycleEnvelopeStore({
    read: () => Promise.resolve(value),
    write: (next) => { value = structuredClone(next); return Promise.resolve(); },
  }, (expected, signal) => {
    calls++;
    const evidence = { ...expected, status: "applied" };
    if (calls !== 1) return Promise.resolve(evidence);
    signal.addEventListener("abort", () => { aborted.resolve(undefined); }, { once: true });
    return late.promise.then(() => evidence);
  }, 20);
  await store.initialize("shop", incarnation);
  const ticket = await store.reserveRegistration(registration);
  await store.submitRegistration(ticket, registration);
  assert.deepEqual(await store.reconcileRegistration(ticket, registration), { status: "pending" });
  await aborted.promise;
  late.resolve(undefined);
  assert.equal((await store.read())?.fence?.lifecycle.phase, "registering");
  assert.deepEqual(await store.reconcileRegistration(ticket, registration), { status: "verified" });
});
