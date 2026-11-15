import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedServiceDigest, managedServiceName, parseManagedServicePlan } from "../../src/contracts/managed-service-plan.ts";
import { matchManagedVolumeEvidence } from "../../src/contracts/managed-volume-evidence.ts";
import { ownedVolume } from "../../src/contracts/owned-volume.ts";

const matchManagedVolumeReceipts = (plan: unknown, receipts: unknown) => matchManagedVolumeEvidence(plan, receipts,
  Array.isArray(receipts) ? receipts.map((receipt: unknown) => ({ status: "owned", receipt })) : undefined);

const fixture = () => {
  const owner = { version: 1, app: "shop", incarnation: randomUUID(), dataOwner: randomUUID() } as const;
  const volume = ownedVolume(owner.app, owner.dataOwner, randomUUID(), "database"); assert.ok(volume.ok);
  const registration = { version: 1, app: owner.app, incarnation: owner.incarnation, actionId: owner.incarnation + ":1", registrationGeneration: randomUUID() } as const;
  const plan = parseManagedServicePlan({ version: 1, runtime: "swarm", owner, service: "db", nativeName: managedServiceName(owner, "db"), role: "retained-dependency", overlap: "forbidden", handoffCheck: null,
    image: "localhost:5000/shop/database@sha256:" + "a".repeat(64), inputs: { version: 1, registration, configurationIdentity: "sha256:" + "b".repeat(64), environment: {} },
    command: null, entrypoint: null, resources: { memoryBytes: 134217728, reserveMemoryBytes: 67108864, nanoCpus: 250000000, reserveNanoCpus: 125000000 },
    health: { command: ["/health"], intervalSeconds: 2, timeoutSeconds: 1, startPeriodSeconds: 20, retries: 2 }, stopGraceSeconds: 30,
    host: { node: "a".repeat(25), cluster: "b".repeat(25), routingNetwork: null }, privateNetwork: { id: "d".repeat(25), name: `kayra-app-${owner.incarnation}` },
    mounts: [{ volume: volume.value, target: "/var/lib/database", readOnly: false, noCopy: true }], dependencies: [],
  }); assert.ok(plan.ok);
  return { plan: plan.value, receipt: { volume: volume.value, createdAt: "2026-11-15T11:00:00Z" } };
};

test("a volume plan is immutable before creation and execution receipts bind separately to exact allocations", () => {
  const { plan, receipt } = fixture(); const digest = managedServiceDigest(plan);
  assert.equal(JSON.stringify(plan).includes("createdAt"), false);
  const result = matchManagedVolumeReceipts(plan, [receipt]); assert.ok(result.ok);
  assert.equal(result.value[0]?.createdAt, receipt.createdAt); assert.deepEqual(result.value[0].volume, receipt.volume);
  assert.equal(managedServiceDigest(plan), digest); assert.ok(Object.isFrozen(result.value)); assert.ok(Object.isFrozen(result.value[0]));
  assert.equal(parseManagedServicePlan({ ...plan, mounts: [{ ...plan.mounts[0], createdAt: receipt.createdAt }] }).ok, false);
});

test("missing, duplicate, extra and malformed receipts cannot satisfy a planned mount", () => {
  const { plan, receipt } = fixture();
  for (const evidence of [undefined, [], [receipt, receipt], Array(1), [{ ...receipt, createdAt: "invalid" }], [{ ...receipt, secret: "private" }], [{ ...receipt, volume: { ...receipt.volume, key: "foreign" } }],
    [{ ...receipt, volume: { ...receipt.volume, dataOwner: randomUUID() } }], [{ ...receipt, volume: { ...receipt.volume, app: "foreign" } }],
  ]) assert.equal(matchManagedVolumeReceipts(plan, evidence).ok, false);
  const foreign = ownedVolume("shop", receipt.volume.dataOwner, randomUUID(), "other"); assert.ok(foreign.ok);
  assert.equal(matchManagedVolumeReceipts(plan, [{ volume: foreign.value, createdAt: receipt.createdAt }]).ok, false);
  assert.equal(matchManagedVolumeReceipts(plan, [receipt, { volume: foreign.value, createdAt: receipt.createdAt }]).ok, false);
});

test("one allocation mounted at multiple targets requires one unambiguous execution receipt", () => {
  const { plan, receipt } = fixture(); const input = { ...plan, mounts: [...plan.mounts, { ...plan.mounts[0], target: "/backup", readOnly: true }] };
  const matched = matchManagedVolumeReceipts(input, [receipt]); assert.ok(matched.ok); assert.equal(matched.value.length, 2);
  assert.ok(matched.value.every((mount) => mount.createdAt === receipt.createdAt));
  assert.equal(matchManagedVolumeReceipts(input, [receipt, { ...receipt, createdAt: "2026-11-15T12:00:00Z" }]).ok, false);
});

test("an unmounted service cannot acquire an unrelated volume receipt", () => {
  const { plan, receipt } = fixture(); const input = { ...plan, mounts: [] };
  assert.deepEqual(matchManagedVolumeReceipts(input, []), { ok: true, value: [] });
  assert.equal(matchManagedVolumeReceipts(input, [receipt]).ok, false);
});

test("receipt matching ignores hostile iterators and snapshots indexed volume identities", () => {
  const { plan, receipt } = fixture(); const receipts = [receipt];
  // eslint-disable-next-line functional/immutable-data -- hostile input must not substitute a receipt during iteration
  Object.defineProperty(receipts, Symbol.iterator, { value: function* () { yield { ...receipt, volume: { ...receipt.volume, dataOwner: randomUUID() } }; } });
  const result = matchManagedVolumeReceipts(plan, receipts); assert.ok(result.ok); assert.deepEqual(result.value[0]?.volume, receipt.volume);
});

test("missing, foreign, unavailable or replaced native creation evidence cannot authorize mounts", () => {
  const { plan, receipt } = fixture();
  for (const observed of [[], undefined, Array(1), [{ status: "absent" }], [{ status: "foreign" }], [{ status: "unavailable" }],
    [{ status: "owned", receipt: { ...receipt, createdAt: "2026-11-15T12:00:00Z" } }],
    [{ status: "owned", receipt: { ...receipt, volume: { ...receipt.volume, dataOwner: randomUUID() } } }],
    [{ status: "owned", receipt }, { status: "owned", receipt }],
  ]) assert.equal(matchManagedVolumeEvidence(plan, [receipt], observed).ok, false);
  assert.equal(matchManagedVolumeEvidence(plan, [receipt], [{ status: "owned", receipt }]).ok, true);
});
