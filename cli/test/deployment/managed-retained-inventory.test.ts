import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { managedServiceDigest, managedServiceName } from "../../src/contracts/managed-service-plan.ts";
import { parseManagedServiceBarrier } from "../../src/server/deployment/managed-service-barrier.ts";
import { prepareManagedInventoryTransition } from "../../src/server/deployment/managed-retained-inventory.ts";
import type { ServiceObservation } from "../../src/contracts/swarm-service.ts";

const fixture = async () => {
  const { plan } = await managedPlanFixture(); const db = plan.services["db"]; assert.ok(db);
  const services = Object.fromEntries(Object.entries(plan.services).filter(([name]) => name !== "db").map(([name, value]) => [name, { ...value, dependencies: [] }]));
  const roles = Object.fromEntries(Object.entries(plan.rollout.services).filter(([name]) => name !== "db"));
  const previous = parseManagedApplicationPlan({ ...plan, services, rollout: { ...plan.rollout, services: roles } }); assert.ok(previous.ok);
  const id = "s".repeat(25); const scope = { app: db.owner.app, incarnation: db.owner.incarnation, dataOwner: db.owner.dataOwner, service: "db" };
  const barrier = parseManagedServiceBarrier({ version: 1, createdAt: 1000, action: { ...scope, action: db.owner.incarnation + ":3:recover", plan: managedServiceDigest(db), effect: "remove", deadline: 91000 },
    prior: [{ id, version: 5 }], nativeId: id, steps: [{ effect: "remove", attempt: 1, expected: { id, version: 5 } }, { effect: "scrub", attempt: 1, expected: { id, version: 6 } }], phase: "complete", reason: null, proof: { native: { id, version: 7 }, at: 1000 } });
  const observed: ServiceObservation = { status: "owned", id, version: 8, action: scope.incarnation + ":3:recover:scrub:1", plan: barrier.action.plan, taskPlan: barrier.action.plan, effect: "scrub", taskEffect: "scrub", tombstone: true, retainedInputsCleared: true, containersStopped: true, containersConverged: true, specMatches: null, replicas: 0, endpoint: "dnsrr", update: "completed", tasks: [] };
  const input = { previous: previous.value, candidate: previous.value, active: [], retired: [{ plan: db, barrier }] };
  const ports = { inputs: { compare: () => Promise.resolve("unchanged" as const) }, services: { observe: () => Promise.resolve(observed) }, now: () => 1000 };
  return { plan, db, input, ports, observed };
};

test("a dependency added by a failed candidate may stay omitted only with a fresh owned container-free retirement barrier", async () => {
  const f = await fixture(); const result = await prepareManagedInventoryTransition(f.input, f.ports, 91000); assert.ok(result.ok);
  assert.equal(result.value.transition.plan.services["db"], undefined); assert.equal(result.value.retired.length, 1); assert.deepEqual(result.value.retired[0]?.plan, f.db);
  assert.equal(result.value.reactivation.length, 0); assert.equal(result.value.transition.resources.target.cpu, 200);
});

test("an unchanged retired dependency returns its scrubbed baseline for explicit reactivation without changing data identity", async () => {
  const f = await fixture(); const result = await prepareManagedInventoryTransition({ ...f.input, candidate: f.plan }, f.ports, 91000); assert.ok(result.ok);
  assert.deepEqual(result.value.transition.plan.services["db"], f.db); assert.equal(result.value.reactivation[0]?.kind, "barrier"); assert.equal(result.value.reactivation[0].action.effect, "scrub");
  assert.equal(result.value.reactivation[0].native.version, 8); assert.equal(result.value.reactivation[0].action.deadline, 91000); assert.equal(result.value.retired[0]?.barrier.proof?.native.version, 7);
});

test("missing native objects, stale barriers and live containers never establish inactive retained data", async () => {
  const f = await fixture(); assert.equal(f.observed.status, "owned");
  for (const observation of [{ status: "absent" }, { ...f.observed, id: "x".repeat(25) }, { ...f.observed, version: 6 }, { ...f.observed, containersStopped: false }, { ...f.observed, action: f.db.owner.incarnation + ":4" } ] as const) {
    const result = await prepareManagedInventoryTransition(f.input, { ...f.ports, services: { observe: () => Promise.resolve(observation) } }, 91000); assert.equal(result.ok, false);
  }
});

test("retirement cannot remove an active dependency or change its owner, specification or recovery role", async () => {
  const f = await fixture(); const retired = f.input.retired[0]; assert.ok(retired);
  for (const input of [{ ...f.input, previous: f.plan }, { ...f.input, active: [f.db] }, { ...f.input, retired: [{ ...retired, plan: { ...f.db, owner: { ...f.db.owner, dataOwner: randomUUID() } } }] }]) assert.equal((await prepareManagedInventoryTransition(input, f.ports, 91000)).ok, false);
  const changed = parseManagedApplicationPlan({ ...f.plan, services: { ...f.plan.services, db: { ...f.db, resources: { ...f.db.resources, memoryBytes: f.db.resources.memoryBytes + 1 } } } }); assert.ok(changed.ok);
  assert.equal((await prepareManagedInventoryTransition({ ...f.input, candidate: changed.value }, f.ports, 91000)).ok, false);
});

test("retired observations are bounded, sanitize private failures and cannot renew the caller's preparation deadline", async () => {
  const f = await fixture();
  const failed = await prepareManagedInventoryTransition(f.input, { ...f.ports, services: { observe: () => { throw new Error("PRIVATE_SECRET"); } } }, 91000); assert.ok(!failed.ok); assert.equal(failed.error.includes("PRIVATE"), false);
  const clock = () => Date.now(); const deadline = clock() + 30;
  const stalled = await prepareManagedInventoryTransition(f.input, { ...f.ports, now: clock, services: { observe: () => Promise.withResolvers<ServiceObservation>().promise } }, deadline); assert.ok(!stalled.ok); assert.match(stalled.error, /deadline/);
  assert.equal((await prepareManagedInventoryTransition(f.input, f.ports, 1000)).ok, false);
});


test("retired data cannot be handed to a renamed retained service to bypass its unchanged specification", async () => {
  const f = await fixture(); const checked = parseManagedApplicationPlan({ ...f.input.candidate, services: { ...f.input.candidate.services, archive: { ...f.db, service: "archive", nativeName: managedServiceName(f.db.owner, "archive") } }, rollout: { ...f.input.candidate.rollout, services: { ...f.input.candidate.rollout.services, archive: { role: "retained-dependency", overlap: "forbidden" } } } }); assert.ok(checked.ok);
  assert.equal((await prepareManagedInventoryTransition({ ...f.input, candidate: checked.value }, f.ports, 91000)).ok, false);
});
