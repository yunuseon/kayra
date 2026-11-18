/* eslint-disable functional/immutable-data, functional/prefer-immutable-types -- records storage reads and injects untrusted creator records */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ownedVolume } from "../../src/contracts/owned-volume.ts";
import { recordedVolumeReceipts } from "../../src/server/deployment/recorded-volume-receipts.ts";
import { parseDataVolumeCreation } from "../../src/server/deployment/data-volume-creation.ts";

const fixture = () => {
  const owner = { version: 1, app: "shop", incarnation: randomUUID(), dataOwner: randomUUID() } as const;
  const first = ownedVolume(owner.app, owner.dataOwner, randomUUID(), "database"); const second = ownedVolume(owner.app, owner.dataOwner, randomUUID(), "cache"); assert.ok(first.ok && second.ok);
  const create = (volume: typeof first.value, recovered: boolean) => parseDataVolumeCreation({ version: 1, owner, deployment: "a".repeat(64), action: { volume, operation: randomUUID(), deadline: 91000 }, createdAt: 1000,
    phase: recovered ? "held" : "ready", reason: recovered ? "deadline" : null, attempts: 1, receipt: recovered ? null : new Date(1000).toISOString(), ...(recovered ? { recoveredReceipt: { createdAt: new Date(1000).toISOString(), observedAt: 92000 } } : {}) });
  const records = new Map<string, unknown>([[first.value.allocation, create(first.value, false)], [second.value.allocation, create(second.value, true)]]); const reads: string[] = [];
  const port = recordedVolumeReceipts(owner, [first.value, second.value], (allocation) => { reads.push(allocation); return Promise.resolve(records.get(allocation)); });
  return { owner, first: first.value, second: second.value, create, records, reads, port };
};

test("receipt projection reads only registered creation records and does not turn a recovered receipt into rollout success", async () => {
  const lab = fixture(); const before = JSON.stringify([...lab.records]);
  assert.deepEqual(await lab.port.read([lab.first, lab.second]), [{ volume: lab.first, createdAt: new Date(1000).toISOString() }, { volume: lab.second, createdAt: new Date(1000).toISOString() }]); assert.deepEqual(lab.reads, [lab.first.allocation, lab.second.allocation]); assert.equal(JSON.stringify([...lab.records]), before);
  const recovered = parseDataVolumeCreation(lab.records.get(lab.second.allocation)); assert.equal(recovered.phase, "held"); assert.equal(recovered.reason, "deadline"); assert.equal(recovered.action.deadline, 91000);
  assert.deepEqual(Object.keys(lab.port), ["read"]); assert.deepEqual(await lab.port.read([]), []);
});

test("unregistered or cross-owner references are refused before storage access", async () => {
  const lab = fixture(); const foreign = ownedVolume("other", randomUUID(), randomUUID(), "database"); assert.ok(foreign.ok);
  for (const references of [[foreign.value], [{ ...lab.first, allocation: randomUUID() }], [lab.first, lab.first]]) assert.equal(await lab.port.read(references), undefined);
  assert.deepEqual(lab.reads, []); assert.throws(() => recordedVolumeReceipts(lab.owner, [foreign.value], () => Promise.resolve(undefined)), /ownership/); assert.throws(() => recordedVolumeReceipts(lab.owner, [lab.first, lab.first], () => Promise.resolve(undefined)), /ownership/);
});

test("foreign, absent or unresolved creator evidence never mints a fresh receipt or partial result", async () => {
  const lab = fixture(); const original = parseDataVolumeCreation(lab.records.get(lab.first.allocation));
  for (const record of [undefined, { status: "owned", receipt: { volume: lab.first, createdAt: new Date(1000).toISOString() } }, { ...original, owner: { ...lab.owner, incarnation: randomUUID() } }, { ...original, phase: "creating", receipt: null }, { ...original, secret: "synthetic-private" }]) {
    lab.records.set(lab.first.allocation, record); assert.equal(await lab.port.read([lab.second, lab.first]), undefined);
  }
  const failing = recordedVolumeReceipts(lab.owner, [lab.first], () => Promise.reject(new Error("synthetic-private must not escape"))); assert.equal(await failing.read([lab.first]), undefined);
});

test("a recorded missing volume retains its original birth reference without asserting physical availability", async () => {
  const lab = fixture(); const known = parseDataVolumeCreation(lab.records.get(lab.first.allocation)); lab.records.set(lab.first.allocation, { ...known, phase: "held", reason: "missing" });
  assert.deepEqual(await lab.port.read([lab.first]), [{ volume: lab.first, createdAt: known.receipt }]);
});
