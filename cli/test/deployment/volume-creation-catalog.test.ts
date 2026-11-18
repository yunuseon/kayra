/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types -- owns native observations, clocks and journal fault injection */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { ownedVolume } from "../../src/contracts/owned-volume.ts";
import type { VolumeObservation, VolumeAction } from "../../src/contracts/owned-volume.ts";
import { volumeCreationCatalog } from "../../src/server/deployment/volume-creation-catalog.ts";
import { parseVolumeCreationCatalog } from "../../src/server/deployment/volume-creation-catalog-state.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import type { OperationJournal } from "../../src/server/deployment/operation.ts";

const fixture = async (t: TestContext) => {
  const path = await mkdtemp(join(tmpdir(), "kayra-volume-catalog-")); const owner = { version: 1, app: "shop", incarnation: randomUUID(), dataOwner: randomUUID() } as const;
  const parsed = ownedVolume(owner.app, owner.dataOwner, randomUUID(), "database"); assert.ok(parsed.ok); const volume = parsed.value;
  let now = 1000; let observed: VolumeObservation = { status: "absent" }; let effect = true; let lose = false; let allow = true; let metadata = true; let journal: Awaited<ReturnType<typeof openJournal>>; let catalog: ReturnType<typeof volumeCreationCatalog> | undefined; let initialized = false; const creates: VolumeAction[] = [];
  const ports = { now: () => now, allowRegistration: () => Promise.resolve(true), authorize: () => Promise.resolve(allow), authorizeReceipt: () => Promise.resolve(metadata), native: {
    observe: () => Promise.resolve(observed), create: async (action: VolumeAction) => { const state = parseVolumeCreationCatalog(await journal.read()); const intent = state.allocations[0]?.creations.at(-1); assert.equal(intent?.phase, "creating"); assert.deepEqual(intent.action, action); creates.push(action); if (effect) observed = { status: "owned", receipt: { volume, createdAt: new Date(Math.floor(now / 1000) * 1000).toISOString() } }; if (lose) throw new Error("lost native acknowledgement"); return "acknowledged" as const; },
  } };
  const reopen = async (wrap: (journal: OperationJournal) => OperationJournal = (value) => value) => { if (initialized) await journal.close(); journal = await openJournal(path, initialized ? "existing" : "initialize"); initialized = true; catalog = volumeCreationCatalog(wrap(journal), owner, ports); };
  const current = () => { assert.ok(catalog); return catalog; };
  await reopen(); await current().register([volume]); t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  const proposal = (operation = randomUUID(), createdAt = now) => ({ deployment: "a".repeat(64), action: { volume, operation, deadline: createdAt + 90000 }, createdAt });
  return { path, owner, volume, ports, creates, proposal, reopen, catalog: current, clock: (value: number) => { now = value; }, observe: (value: VolumeObservation) => { observed = value; }, withoutEffect: () => { effect = false; }, withEffect: () => { effect = true; }, loseAck: () => { lose = true; }, allow: (value: boolean) => { allow = value; }, metadata: (value: boolean) => { metadata = value; } };
};

test("catalog retains one birth across operations and never recreates a recorded missing volume", async (t) => {
  const lab = await fixture(t); const proposal = lab.proposal(); assert.equal((await lab.catalog().prepare(proposal)).status, "pending"); assert.equal(lab.creates.length, 0);
  await lab.catalog().tick(lab.volume, proposal.action.operation); const ready = await lab.catalog().tick(lab.volume, proposal.action.operation); assert.equal(ready.status, "recorded"); const receipt = ready.receipt;
  assert.deepEqual(await lab.catalog().receipts.read([lab.volume]), [receipt]); await lab.reopen(); lab.clock(2000); assert.equal((await lab.catalog().prepare(lab.proposal())).status, "recorded"); assert.equal((await lab.catalog().read())?.allocations[0]?.creations.length, 1);
  lab.observe({ status: "absent" }); assert.equal((await lab.catalog().prepare(lab.proposal())).status, "recorded"); assert.deepEqual(await lab.catalog().receipts.read([lab.volume]), [receipt]); assert.equal(lab.creates.length, 1);
  await assert.rejects(lab.catalog().tick(lab.volume, randomUUID()), /unknown/); assert.deepEqual(Object.keys(lab.catalog().receipts), ["read"]);
});

test("same-operation replay preserves deadlines while an explicit later operation can retry an uncreated allocation", async (t) => {
  const lab = await fixture(t); const first = lab.proposal(); await lab.catalog().prepare(first); lab.clock(92000);
  assert.deepEqual(await lab.catalog().prepare(first), { status: "pending", operation: first.action.operation, deadline: 91000 }); assert.equal((await lab.catalog().tick(lab.volume, first.action.operation)).status, "held");
  await assert.rejects(lab.catalog().prepare({ ...first, action: { ...first.action, deadline: 182000 }, createdAt: 92000 }), /conflicts/);
  const second = lab.proposal(); assert.equal((await lab.catalog().prepare(second)).status, "pending"); await lab.catalog().tick(lab.volume, second.action.operation); assert.equal((await lab.catalog().tick(lab.volume, second.action.operation)).status, "recorded");
  const history = (await lab.catalog().read())?.allocations[0]?.creations; assert.equal(history?.length, 2); assert.equal(history[0]?.action.deadline, 91000); assert.equal(history[1]?.action.deadline, 182000); assert.equal(lab.creates.length, 1);
});

test("expired uncertain creation is observed and sealed before any new operation can create", async (t) => {
  const lab = await fixture(t); const first = lab.proposal(); lab.loseAck(); await lab.catalog().prepare(first); await lab.catalog().tick(lab.volume, first.action.operation); lab.clock(92000);
  assert.equal((await lab.catalog().prepare(lab.proposal())).status, "recorded"); const state = await lab.catalog().read(); assert.ok(state); const old = state.allocations[0]?.creations[0]; assert.equal(old?.phase, "held"); assert.equal(old.reason, "deadline"); assert.equal(old.action.deadline, 91000); assert.ok(old.recoveredReceipt); assert.equal(state.allocations[0]?.creations.length, 1); assert.equal(lab.creates.length, 1);
  await lab.reopen(); assert.equal((await lab.catalog().prepare(lab.proposal())).status, "recorded"); assert.deepEqual(await lab.catalog().read(), state);
});

test("an active old window, failed authority and unavailable/foreign observations cannot append a new creator", async (t) => {
  const lab = await fixture(t); const first = lab.proposal(); await lab.catalog().prepare(first); lab.clock(2000); assert.deepEqual(await lab.catalog().prepare(lab.proposal()), { status: "waiting", until: 91000 });
  lab.clock(92000); lab.allow(false); assert.deepEqual(await lab.catalog().prepare(lab.proposal()), { status: "held", reason: "authorization" }); lab.allow(true); lab.metadata(false); assert.deepEqual(await lab.catalog().prepare(lab.proposal()), { status: "held", reason: "authorization" }); lab.metadata(true);
  for (const status of ["unavailable", "foreign"] as const) { lab.observe({ status }); assert.equal((await lab.catalog().prepare(lab.proposal())).status, "held"); }
  assert.equal((await lab.catalog().read())?.allocations[0]?.creations.length, 1); assert.equal(lab.creates.length, 0);
});

for (const cut of ["before", "after"] as const) test(`catalog ${cut}-replacement failure reopens the same intent without duplicate native creation`, async (t) => {
  const lab = await fixture(t); const proposal = lab.proposal(); await lab.catalog().prepare(proposal); let fail = true;
  await lab.reopen((journal) => ({ read: journal.read, write: async (input) => { const state = parseVolumeCreationCatalog(input); if (fail && state.allocations[0]?.creations.at(-1)?.phase === "creating") { fail = false; if (cut === "after") await journal.write(input); throw new Error("lost catalog acknowledgement"); } await journal.write(input); } }));
  await assert.rejects(lab.catalog().tick(lab.volume, proposal.action.operation), /uncertain/); assert.equal(lab.creates.length, 0); await assert.rejects(lab.catalog().read(), /uncertain/); await lab.reopen(); await lab.catalog().tick(lab.volume, proposal.action.operation); assert.equal((await lab.catalog().tick(lab.volume, proposal.action.operation)).status, "recorded"); assert.equal(lab.creates.length, 1); assert.equal((await lab.catalog().read())?.allocations[0]?.creations[0]?.action.deadline, 91000);
});

test("registration is append-only and contradictory birth histories are refused", async (t) => {
  const lab = await fixture(t); const different = ownedVolume(lab.owner.app, lab.owner.dataOwner, randomUUID(), lab.volume.key); assert.ok(different.ok); await assert.rejects(lab.catalog().register([different.value]), /conflicts/);
  const first = lab.proposal(); await lab.catalog().prepare(first); await lab.catalog().tick(lab.volume, first.action.operation); await lab.catalog().tick(lab.volume, first.action.operation);
  const state = await lab.catalog().read(); assert.ok(state); const creation = state.allocations[0]?.creations[0]; assert.ok(creation);
  assert.throws(() => parseVolumeCreationCatalog({ ...state, allocations: [{ volume: lab.volume, creations: [creation, { ...creation, action: { ...creation.action, operation: randomUUID() }, receipt: new Date(2000).toISOString() }] }] }), /evidence/);
  assert.throws(() => parseVolumeCreationCatalog({ ...state, allocations: [...state.allocations, ...state.allocations] }), /duplicate/);
});

test("an explicit new operation can retry absent uncertain creation without forgetting the original intent", async (t) => {
  const lab = await fixture(t); lab.withoutEffect(); lab.loseAck(); const old = lab.proposal(); await lab.catalog().prepare(old); await lab.catalog().tick(lab.volume, old.action.operation); lab.clock(92000);
  const next = lab.proposal(); assert.equal((await lab.catalog().prepare(next)).status, "pending"); lab.withEffect(); await lab.catalog().tick(lab.volume, next.action.operation); assert.equal((await lab.catalog().tick(lab.volume, next.action.operation)).status, "recorded");
  const creations = (await lab.catalog().read())?.allocations[0]?.creations; assert.equal(creations?.length, 2); assert.equal(creations[0]?.receipt, null); assert.equal(creations[0].action.deadline, old.action.deadline); assert.equal(lab.creates.length, 2);
});

test("lost catalog receipt recovery acknowledgement reopens the original birth rather than a new creator", async (t) => {
  const lab = await fixture(t); lab.loseAck(); const old = lab.proposal(); await lab.catalog().prepare(old); await lab.catalog().tick(lab.volume, old.action.operation); let fail = true;
  await lab.reopen((journal) => ({ read: journal.read, write: async (input) => { await journal.write(input); if (fail && parseVolumeCreationCatalog(input).allocations[0]?.creations[0]?.recoveredReceipt !== undefined) { fail = false; throw new Error("lost recovery acknowledgement"); } } }));
  lab.clock(92000); const next = lab.proposal(); await assert.rejects(lab.catalog().prepare(next), /uncertain/); await lab.reopen(); lab.clock(92500); assert.equal((await lab.catalog().prepare(next)).status, "recorded");
  const state = await lab.catalog().read(); assert.ok(state); const allocation = state.allocations[0]; assert.ok(allocation); assert.equal(allocation.creations.length, 1); const creation = allocation.creations[0]; assert.ok(creation?.recoveredReceipt); assert.equal(creation.recoveredReceipt.observedAt, 92000); assert.equal(lab.creates.length, 1);
});
