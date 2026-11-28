import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import { parseManagedServiceBarrier } from "../../src/server/deployment/managed-service-barrier.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { managedSuccessfulInventoryCarry } from "../../src/server/deployment/managed-lifecycle-inventory.ts";

const fixture = async () => {
  const { plan } = await managedPlanFixture(); const db = plan.services["db"]; assert.ok(db);
  const candidate = parseManagedApplicationPlan({ ...plan, services: Object.fromEntries(Object.entries(plan.services).filter(([name]) => name !== "db").map(([name, value]) => [name, { ...value, dependencies: [] }])), rollout: { ...plan.rollout, services: Object.fromEntries(Object.entries(plan.rollout.services).filter(([name]) => name !== "db")) } }); assert.ok(candidate.ok);
  const scope = { app: db.owner.app, incarnation: db.owner.incarnation, dataOwner: db.owner.dataOwner, service: "db" }; const native = "s".repeat(25);
  const barrier = parseManagedServiceBarrier({ version: 1, createdAt: 1000, action: { ...scope, action: db.owner.incarnation + ":3:recover", plan: managedServiceDigest(db), effect: "remove", deadline: 91000 }, prior: [{ id: native, version: 5 }], nativeId: native,
    steps: [{ effect: "remove", attempt: 1, expected: { id: native, version: 5 } }, { effect: "scrub", attempt: 1, expected: { id: native, version: 6 } }], phase: "complete", reason: null, proof: { native: { id: native, version: 7 }, at: 1000 } });
  const source = parseManagedLifecycleSource({ version: 1, candidate: candidate.value, previous: null, run: randomUUID(), action: db.owner.incarnation + ":4", createdAt: 1000, retained: [], retired: [{ plan: db, barrier }] });
  return { source, db, native };
};

test("inactive dependency records stay bound across successful runs that continue omitting the dependency", async () => {
  const { source } = await fixture(); const next = parseManagedLifecycleSource({ ...source, run: randomUUID(), action: source.candidate.infrastructure.ownership.incarnation + ":5" });
  assert.ok(managedSuccessfulInventoryCarry(source, next).ok);
  assert.equal(managedSuccessfulInventoryCarry(source, { ...next, retired: [] }).ok, false);
  const record = next.retired[0]; assert.ok(record?.barrier.proof);
  const changed = parseManagedLifecycleSource({ ...next, retired: [{ ...record, barrier: { ...record.barrier, proof: { ...record.barrier.proof, native: { ...record.barrier.proof.native, version: 8 } } } }] });
  assert.equal(managedSuccessfulInventoryCarry(source, changed).ok, false);
});

test("a new root cannot bootstrap retirement claims from a supplied native identity", async () => {
  const { source } = await fixture(); assert.equal(managedSuccessfulInventoryCarry(null, source).ok, false);
  const empty = parseManagedLifecycleSource({ ...source, retired: [] }); assert.ok(managedSuccessfulInventoryCarry(null, empty).ok);
  assert.equal(managedSuccessfulInventoryCarry(empty, source).ok, false);
});

test("an active retained reference requires the verified previous release, not only matching app labels", async () => {
  const { plan } = await managedPlanFixture(); const db = plan.services["db"]; assert.ok(db);
  assert.throws(() => parseManagedLifecycleSource({ version: 1, candidate: plan, previous: null, run: randomUUID(), action: db.owner.incarnation + ":4", createdAt: 1000, retired: [], retained: [{ name: "db", kind: "active", native: { id: "s".repeat(25), version: 1 }, action: { app: db.owner.app, incarnation: db.owner.incarnation, dataOwner: db.owner.dataOwner, service: "db", action: db.owner.incarnation + ":2", effect: "apply", plan: managedServiceDigest(db), deadline: 91000 } }] }), /baseline disagrees/);
});
