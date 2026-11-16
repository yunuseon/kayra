/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- models runtime, faults and owning journal handles */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { managedApplicationDigest, parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import type { ManagedServiceAction, ManagedServiceScope } from "../../src/contracts/managed-swarm-service.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedServicePlan } from "../../src/contracts/managed-service-plan.ts";
import type { ServiceObservation } from "../../src/contracts/swarm-service.ts";
import type { JobPlan } from "../../src/contracts/one-shot-job.ts";
import { jobName } from "../../src/contracts/one-shot-job.ts";
import { managedGroupPreparation } from "../../src/server/deployment/managed-group-preparation.ts";
import { managedMigrationInputs } from "../../src/server/deployment/managed-migration-inputs.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { jobRuntime } from "./one-shot-fixture.ts";

const fixture = async (t: TestContext, migrations = false) => {
  const data = await managedPlanFixture(); const checked = parseManagedApplicationPlan({ ...data.plan, rollout: { ...data.plan.rollout, migrations: migrations ? data.plan.rollout.migrations : [] } }); assert.ok(checked.ok); const plan = checked.value;
  const path = await mkdtemp(join(tmpdir(), "kayra-managed-parent-")); const artifacts = await openArtifactStore(join(path, "artifacts"));
  let journal = await openJournal(path); let clock = 1000; let serviceCreates = 0; let reactivations = 0; let loseStart = false; let dbHealthy = true; let admitted = true;
  let database: ServiceObservation = { status: "absent" };
  const nodes = new Map<string, ReturnType<typeof jobRuntime>>();
  const nodeFor = (job: JobPlan) => { const name = jobName(job.scope); let node = nodes.get(name); if (node === undefined) { node = jobRuntime(job); nodes.set(name, node); } node.now(clock); return node; };
  const apply = (action: ManagedServiceAction, _expected: unknown, spec: ManagedServicePlan) => {
      assert.equal(spec.role, "retained-dependency"); serviceCreates++;
      const nativeVersion = database.status === "owned" ? database.version + 1 : 1;
      database = { status: "owned", id: "s".repeat(25), version: nativeVersion, action: action.action, effect: action.effect, taskEffect: action.effect, plan: action.plan, taskPlan: action.plan,
        tombstone: false, containersConverged: true, containersStopped: true, retainedInputsCleared: false, specMatches: true, replicas: 1, endpoint: "vip", update: "completed",
        tasks: [{ id: "t".repeat(25), incarnation: action.incarnation, effect: action.effect, plan: action.plan, action: action.action, desired: "running", state: "running", health: "healthy" }] };
      return Promise.resolve("acknowledged" as const);
  };
  const ports = { ...artifacts, now: () => clock, authorize: () => Promise.resolve(admitted), services: {
    observe: (scope: ManagedServiceScope) => { assert.deepEqual(Object.keys(scope).toSorted(), ["app", "dataOwner", "incarnation", "service"]); return Promise.resolve(database); },
    observeDesired: () => Promise.resolve(database.status === "owned" && !dbHealthy ? { ...database, tasks: database.tasks.map((task) => ({ ...task, health: "unhealthy" as const })) } : database),
    apply, reactivate: (action: ManagedServiceAction, expected: unknown, spec: ManagedServicePlan) => { reactivations++; return apply(action, expected, spec); },
  }, jobs: {
    observe: (job: JobPlan) => nodeFor(job).native.observe(job),
    create: (job: JobPlan) => {
      assert.ok(dbHealthy); const reference = managedMigrationInputs(plan, job); assert.ok(reference.ok);
      const environment = Object.fromEntries(Object.entries(reference.value.environment).map(([key, binding]) => [key, binding.kind === "literal" ? binding.value : "PRIVATE-MATERIALIZED"]));
      return nodeFor(job).native.create(job, environment);
    },
    start: async (job: JobPlan, id: string, deadline?: number) => { const value = await nodeFor(job).native.start(job, id, deadline); if (loseStart) throw new Error("lost group migration acknowledgement"); return value; },
    fence: (job: JobPlan, id: string | null, deadline: number) => nodeFor(job).native.fence(job, id, deadline),
  } };
  let owner = managedGroupPreparation(journal, ports); const run = randomUUID(); const action = plan.infrastructure.registration.incarnation + ":2";
  t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  const drive = async () => { for (let step = 0; step < 100; step++) { const state = await owner.tick(); if (state.phase === "ready" || state.phase === "held") return state; } throw new Error("group preparation did not settle"); };
  return { plan, run, action, ports, nodes, owner: () => owner, journal: () => journal, drive,
    prepare: () => owner.prepare(plan, run, action, []), serviceCreates: () => serviceCreates, reactivations: () => reactivations, observe: (value: ServiceObservation) => { database = value; },
    now: (value: number) => { clock = value; }, loseStart: () => { loseStart = true; }, unhealthy: () => { dbHealthy = false; }, deny: () => { admitted = false; },
    reopen: async () => { await journal.close(); journal = await openJournal(path, "existing"); owner = managedGroupPreparation(journal, ports); },
  };
};

test("one managed parent creates retained dependencies before opening its bounded consumer window", async (t) => {
  const lab = await fixture(t); const initial = await lab.prepare(); assert.deepEqual(await lab.prepare(), initial);
  const ready = await lab.drive(); assert.equal(ready.phase, "ready"); assert.equal(lab.serviceCreates(), 1); assert.equal(lab.nodes.size, 0);
  assert.equal(ready.nodes[0]?.execution?.phase, "converged"); assert.equal(ready.consumerDeadline, 91000);
  await lab.reopen(); assert.deepEqual(await lab.owner().tick(), ready); assert.equal(lab.serviceCreates(), 1);
  lab.now(999999); assert.deepEqual(await lab.prepare(), ready); assert.equal((await lab.owner().tick()).consumerDeadline, ready.consumerDeadline); assert.equal(lab.serviceCreates(), 1);
});

test("managed preparation binds private migration inputs after dependency readiness and recovers lost Start acknowledgement", async (t) => {
  const lab = await fixture(t, true); const initial = await lab.prepare(); lab.loseStart();
  await assert.rejects(lab.drive(), /lost group migration acknowledgement/); assert.equal(lab.serviceCreates(), 1);
  const interrupted = await lab.owner().read(); const original = interrupted?.sequence?.steps[0]?.executionDeadline;
  await lab.reopen(); const ready = await lab.drive(); assert.equal(ready.phase, "ready"); assert.equal(ready.sequence?.phase, "succeeded");
  assert.equal(ready.migrationDeadline, initial.migrationDeadline); assert.equal(ready.sequence.steps[0]?.executionDeadline, original);
  assert.equal([...lab.nodes.values()].reduce((total, node) => total + node.executions(), 0), 1);
  assert.equal(JSON.stringify(await lab.journal().read()).includes("PRIVATE-MATERIALIZED"), false);
});

test("expiry, unhealthy dependencies and denied admission cannot start migration work", async (t) => {
  const expired = await fixture(t, true); await expired.prepare(); expired.now(91000); assert.equal((await expired.owner().tick()).reason, "deadline"); assert.equal(expired.serviceCreates(), 0);
  const denied = await fixture(t, true); await denied.prepare(); denied.deny(); const held = await denied.drive(); assert.equal(held.phase, "held"); assert.equal(denied.serviceCreates(), 0); assert.equal(denied.nodes.size, 0);
  const unhealthy = await fixture(t, true); await unhealthy.prepare(); await unhealthy.owner().tick(); await unhealthy.owner().tick(); unhealthy.unhealthy();
  for (let tick = 0; tick < 4; tick++) await unhealthy.owner().tick();
  assert.equal(unhealthy.nodes.size, 0); unhealthy.now(91000); assert.equal((await unhealthy.owner().tick()).phase, "held");
});

test("unavailable maintenance or coordinated-check capability refuses before intent and effects", async (t) => {
  const lab = await fixture(t);
  const maintenance = { ...lab.plan, grants: { ...lab.plan.grants, maintenance: true }, rollout: { ...lab.plan.rollout, strategy: "maintenance" as const } };
  await assert.rejects(lab.owner().prepare(maintenance, lab.run, lab.action, []), /capabilities/);
  assert.equal(await lab.journal().read(), undefined); assert.equal(lab.serviceCreates(), 0);
});


test("a later preparation reuses a verified retained baseline without creating or restarting it", async (t) => {
  const lab = await fixture(t); await lab.prepare(); const ready = await lab.drive(); const node = ready.nodes[0]; assert.ok(node?.ready);
  const path = await mkdtemp(join(tmpdir(), "kayra-managed-reuse-")); const journal = await openJournal(path);
  t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  const owner = managedGroupPreparation(journal, lab.ports); const action = ready.incarnation + ":3";
  await owner.prepare(lab.plan, randomUUID(), action, [{ name: node.name, kind: "active", action: node.ready.action, native: node.ready.native }]);
  await owner.tick(); const reused = await owner.tick(); assert.equal(reused.phase, "ready"); assert.equal(reused.nodes[0]?.execution, null); assert.equal(lab.serviceCreates(), 1);
});

test("a recorded empty retained barrier selects explicit reactivation before migrations", async (t) => {
  const lab = await fixture(t); const service = lab.plan.services["db"]; assert.ok(service); const scope = service.owner;
  const previous: ManagedServiceAction = { app: scope.app, service: service.service, incarnation: scope.incarnation, dataOwner: scope.dataOwner,
    action: scope.incarnation + ":1:scrub:1", plan: managedServiceDigest(service), deadline: 999, effect: "scrub" };
  lab.observe({ status: "owned", id: "s".repeat(25), version: 1, action: previous.action, effect: "scrub", taskEffect: "scrub", plan: previous.plan, taskPlan: previous.plan,
    tombstone: true, containersConverged: true, containersStopped: true, retainedInputsCleared: true, specMatches: null, replicas: 0, endpoint: "dnsrr", update: "completed", tasks: [] });
  await lab.owner().prepare(lab.plan, lab.run, lab.action, [{ name: "db", kind: "barrier", action: previous, native: { id: "s".repeat(25), version: 1 } }]);
  const ready = await lab.drive(); assert.equal(ready.phase, "ready"); assert.equal(ready.nodes[0]?.execution?.mode, "reactivate-retained"); assert.equal(lab.reactivations(), 1);
});

test("a missing recorded dependency holds rather than creating a fresh empty instance", async (t) => {
  const lab = await fixture(t); const service = lab.plan.services["db"]; assert.ok(service); const scope = service.owner;
  const previous: ManagedServiceAction = { app: scope.app, service: service.service, incarnation: scope.incarnation, dataOwner: scope.dataOwner,
    action: scope.incarnation + ":1", plan: managedServiceDigest(service), deadline: 999, effect: "apply" };
  await lab.owner().prepare(lab.plan, lab.run, lab.action, [{ name: "db", kind: "active", action: previous, native: { id: "s".repeat(25), version: 1 } }]);
  assert.equal((await lab.owner().tick()).phase, "held"); assert.equal(lab.serviceCreates(), 0); assert.equal(lab.nodes.size, 0);
});


test("managed preparation snapshots an untrusted proposal before waiting on its writer queue", async (t) => {
  const lab = await fixture(t); const db = lab.plan.services["db"]; assert.ok(db);
  const input = { ...lab.plan, services: { ...lab.plan.services, db: { ...db, resources: { ...db.resources } } } };
  const preparing = lab.owner().prepare(input, lab.run, lab.action, []); input.services.db.resources.memoryBytes++;
  assert.equal((await preparing).plan, managedApplicationDigest(lab.plan)); assert.equal(lab.serviceCreates(), 0);
  assert.equal((await lab.drive()).phase, "ready"); assert.equal(lab.serviceCreates(), 1);
});
