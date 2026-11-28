/* eslint-disable functional/immutable-data -- records native test effects and simulated time */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ownedVolume } from "../../src/contracts/owned-volume.ts";
import { reconcileManagedPurge } from "../../src/server/deployment/managed-purge-effects.ts";
import type { ManagedPurgeEffectsPorts } from "../../src/server/deployment/managed-purge-effects.ts";
import { parseManagedPurge } from "../../src/server/deployment/managed-purge-state.ts";
import { managedPurgeInventory } from "../../src/server/deployment/managed-purge-inventory.ts";

const fixture = () => {
  const owner = { version: 1 as const, app: "shop", incarnation: randomUUID(), dataOwner: randomUUID() };
  const first = ownedVolume(owner.app, owner.dataOwner, randomUUID(), "data");
  const second = ownedVolume(owner.app, owner.dataOwner, randomUUID(), "cache");
  assert.ok(first.ok && second.ok);
  const volume = first.value;
  const retired = second.value;
  const createdAt = 2000;
  const creation = Object.freeze({
    version: 1, deployment: "a".repeat(64), owner, createdAt,
    action: { volume, operation: randomUUID(), deadline: createdAt + 90_000 },
  });
  const catalog = (record: unknown) => ({
    version: 1, sequence: 1, owner, allocations: [{ volume, creations: [record] }],
  });
  return { owner, volume, retired, catalog, creation };
};

test("purge inventory binds the exact recorded birth and retains never-created allocations", () => {
  const { owner, volume, retired, catalog, creation } = fixture();
  const createdAt = new Date(creation.createdAt).toISOString();
  const observed = catalog({ ...creation, phase: "ready", attempts: 1, receipt: createdAt, reason: null });
  assert.deepEqual(managedPurgeInventory(observed, owner, [volume, retired]), [
    { volume, birth: { volume, createdAt } }, { volume: retired, birth: null },
  ]);
  assert.throws(() => managedPurgeInventory(observed, owner, [retired]), /lacks owned scope/);
  assert.throws(() => managedPurgeInventory(observed, { ...owner, incarnation: randomUUID() }, [volume]), /lacks owned scope/);
});

test("purge cannot use an uncertain create or assume that an unacknowledged allocation never existed", () => {
  const { owner, volume, catalog, creation } = fixture();
  const uncertain = { ...creation, phase: "held", attempts: 1, receipt: null, reason: "deadline" };
  assert.throws(() => managedPurgeInventory(catalog(uncertain), owner, [volume]), /uncertain volume creation/);
  const createdAt = new Date(creation.createdAt).toISOString();
  const recovered = { ...uncertain, recoveredReceipt: { createdAt, observedAt: creation.action.deadline } };
  assert.deepEqual(managedPurgeInventory(catalog(recovered), owner, [volume]), [{ volume, birth: { volume, createdAt } }]);
});

test("purge observes every attachment before delete and recovers one lost delete acknowledgement", async () => {
  const { owner, volume, retired, catalog, creation } = fixture();
  const createdAt = new Date(creation.createdAt).toISOString();
  const entries = managedPurgeInventory(catalog({ ...creation, phase: "ready", attempts: 1, receipt: createdAt, reason: null }), owner, [volume, retired]);
  const initial = parseManagedPurge({
    version: 1, request: randomUUID(), ticket: owner.incarnation + ":5", action: owner.incarnation + ":5", removal: randomUUID(),
    createdAt: 3000, deadline: 93000, finishedAt: null, phase: "preflight", reason: null,
    operator: { actor: { kind: "operator-control", identity: "fixture-operator" }, reason: "Delete data after completed app removal" },
    entries: entries.map((item) => ({ ...item, phase: "pending" })),
  });
  const calls = { deletes: 0, attached: true, gone: false, now: 3000 };
  const ports: ManagedPurgeEffectsPorts = {
    allowed: () => Promise.resolve(true), now: () => calls.now, persist: (next) => Promise.resolve(next),
    native: {
      observe: (target) => Promise.resolve(target.allocation === volume.allocation && !calls.gone ? { status: "owned", receipt: { volume, createdAt } } : { status: "absent" }),
      attachments: (target) => Promise.resolve({ status: "observed", containers: [], services: target.allocation === retired.allocation && calls.attached ? ["a".repeat(25)] : [] }),
      remove: (action, expected) => {
        assert.equal(action.operation, initial.request);
        assert.deepEqual(expected, { volume, createdAt });
        calls.deletes++;
        calls.gone = true;
        return Promise.reject(new Error("lost native response"));
      },
    },
  };
  const held = await reconcileManagedPurge(initial, ports);
  assert.equal(held.phase, "held");
  assert.equal(held.reason, "attachments");
  assert.equal(calls.deletes, 0);
  calls.attached = false;
  const approved = await reconcileManagedPurge(initial, ports);
  assert.equal(approved.phase, "deleting");
  const intent = await reconcileManagedPurge(approved, ports);
  assert.equal(intent.entries[0]?.phase, "deleting");
  assert.equal(calls.deletes, 0);
  const uncertain = await reconcileManagedPurge(intent, ports);
  assert.deepEqual(uncertain, intent);
  assert.equal(calls.deletes, 1);
  const observed = await reconcileManagedPurge(uncertain, ports);
  assert.equal(observed.entries[0]?.phase, "absent");
  const bothAbsent = await reconcileManagedPurge(observed, ports);
  const complete = await reconcileManagedPurge(bothAbsent, ports);
  assert.equal(complete.phase, "complete");
  assert.equal(complete.deadline, initial.deadline);
  assert.equal(calls.deletes, 1);
  calls.now = initial.deadline;
  assert.equal((await reconcileManagedPurge(intent, ports)).reason, "deadline");
  assert.equal(calls.deletes, 1);
});
