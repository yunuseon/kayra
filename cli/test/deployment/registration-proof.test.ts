import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { JournalValue } from "../../src/server/deployment/journal.ts";
import { openLifecycleEnvelopeStore } from "../../src/server/deployment/lifecycle-envelope-store.ts";
import { verifiedRegistration } from "../../src/server/deployment/verified-registration.ts";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { parseLifecycleEnvelope } from "../../src/server/deployment/lifecycle-envelope.ts";
import { beginLifecycleWork, lifecycleActionId, settleLifecycleWork } from "../../src/server/deployment/lifecycle-fence.ts";
import { admitTicket, completeTicket, lookupTicket, maxTerminalReceipts, reserveTicket } from "../../src/server/deployment/lifecycle-tickets.ts";

const generation = "22222222-2222-4222-8222-222222222222";

test("verified registration survives bounded terminal-ticket history and reopen", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kayra-registration-proof-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "index");
  const index = await createLifecycleAppIndex(root, (identity) => Promise.resolve({ ...identity, status: "applied" }));
  await index.prepareApp("shop");
  const ticket = await index.reserveRegistration("shop", generation, "swarm");
  await index.submitRegistration("shop", ticket, generation);
  await index.reconcileRegistration("shop", ticket, generation);
  const policy = await index.registrationPolicy("shop");
  await index.close();
  const path = join(root, createHash("sha256").update("shop").digest("hex"), "state.json");
  const input: unknown = JSON.parse(await readFile(path, "utf8"));
  const parsed = parseLifecycleEnvelope(input);
  assert.ok(parsed.ok && parsed.value.fence !== null);
  // eslint-disable-next-line functional/no-let -- simulate later fully settled deployments through the real protocol
  let state = parsed.value;
  for (const iteration of Array.from({ length: maxTerminalReceipts + 2 }, (_, index) => index)) {
    const reserved = reserveTicket(state.tickets);
    assert.ok(reserved.ok);
    const admitted = admitTicket(reserved.value.state, reserved.value.ticket, { kind: "deploy", planDigest: iteration.toString(16).padStart(64, "0") });
    assert.ok(admitted.ok);
    const completed = completeTicket(admitted.value.state, reserved.value.ticket, "success");
    const begun = beginLifecycleWork(state.fence, "deploy");
    assert.ok(completed.ok && begun.ok);
    const settled = settleLifecycleWork(begun.value, lifecycleActionId(begun.value, begun.value.nextAction - 1));
    assert.ok(settled.ok);
    state = { ...state, tickets: completed.value, fence: settled.value };
  }
  assert.deepEqual(lookupTicket(state.tickets, ticket), { ok: true, value: { status: "expired" } });
  await writeFile(path, JSON.stringify(state));
  const reopened = await openLifecycleAppIndex(root);
  try {
    assert.deepEqual(await reopened.registrationPolicy("shop"), policy);
    assert.deepEqual(await reopened.submitRegistration("shop", ticket, generation), { status: "terminal", outcome: "success" });
    assert.deepEqual(await reopened.reconcileRegistration("shop", ticket, generation), { status: "terminal", outcome: "success" });
    assert.equal(parseLifecycleEnvelope(Object.fromEntries(Object.entries(state).filter(([key]) => key !== "registrationReceipt"))).ok, false);
  } finally { await reopened.close(); }
});

test("old journals gain a certificate only from an actual matching successful terminal receipt", async () => {
  // eslint-disable-next-line functional/no-let -- simulated durable state
  let value: JournalValue | undefined;
  const journal = { read: () => Promise.resolve(value), write: (next: JournalValue) => { value = structuredClone(next); return Promise.resolve(); } };
  const incarnation = "11111111-1111-4111-8111-111111111111";
  const store = openLifecycleEnvelopeStore(journal, (identity) => Promise.resolve({ ...identity, status: "applied" }));
  await store.initialize("shop", incarnation);
  const ticket = await store.reserveRegistration(generation, "swarm");
  await store.submitRegistration(ticket, generation);
  const pending = await store.read();
  assert.equal(pending?.registrationReceipt, undefined);
  await store.reconcileRegistration(ticket, generation);
  const state = await store.read();
  assert.ok(state?.registrationReceipt !== undefined);
  const legacy = Object.fromEntries(Object.entries(state).filter(([key]) => key !== "registrationReceipt"));
  const upgraded = parseLifecycleEnvelope(legacy);
  assert.ok(upgraded.ok);
  assert.deepEqual(upgraded.value.registrationReceipt, state.registrationReceipt);
  assert.equal(Object.hasOwn(legacy, "registrationReceipt"), false);
  const failed = { ...state.tickets, receipts: state.tickets.receipts.map((receipt) => ({ ...receipt, outcome: "failure" })) };
  assert.equal(parseLifecycleEnvelope({ ...state, tickets: failed }).ok, false);
  assert.throws(() => verifiedRegistration("shop", { ...legacy, tickets: failed }), /no verified receipt/);
  for (const certificate of [
    { ...state.registrationReceipt, runtime: "compose" },
    { ...state.registrationReceipt, ticket: incarnation + ":2" },
    { ...state.registrationReceipt, metadata: { ...state.registrationReceipt.metadata, registrationGeneration: incarnation } },
    { ...state.registrationReceipt, metadata: { ...state.registrationReceipt.metadata, actionId: incarnation + ":2" } },
  ]) assert.equal(parseLifecycleEnvelope({ ...state, registrationReceipt: certificate }).ok, false);
});

test("a lost verified-write acknowledgement reopens the same certificate without observing again", async () => {
  // eslint-disable-next-line functional/no-let -- simulate a committed write with a lost acknowledgement
  let value: JournalValue | undefined;
  // eslint-disable-next-line functional/no-let -- inject uncertainty after intent
  let lose = false;
  const read = () => Promise.resolve(value);
  const store = openLifecycleEnvelopeStore({ read, write: (next: JournalValue) => {
    value = structuredClone(next);
    return lose ? Promise.reject(new Error("lost certificate acknowledgement")) : Promise.resolve();
  } }, (identity) => Promise.resolve({ ...identity, status: "applied" }));
  await store.initialize("shop", "11111111-1111-4111-8111-111111111111");
  const ticket = await store.reserveRegistration(generation);
  await store.submitRegistration(ticket, generation);
  lose = true;
  await assert.rejects(store.reconcileRegistration(ticket, generation), /lost certificate/);
  await assert.rejects(store.read(), /uncertain/);
  const reopened = openLifecycleEnvelopeStore({ read, write: () => { throw new Error("verified recovery must not write"); } }, () => { throw new Error("verified recovery must not observe again"); });
  assert.deepEqual(await reopened.reconcileRegistration(ticket, generation), { status: "terminal", outcome: "success" });
  assert.equal((await reopened.read())?.registrationReceipt?.metadata.registrationGeneration, generation);
});
