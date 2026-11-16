/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- models runtime effects, interrupted acknowledgements and journal reopening */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedApplicationPlan, managedApplicationDigest } from "../../src/contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedServiceAction } from "../../src/contracts/managed-swarm-service.ts";
import type { ServiceObservation } from "../../src/contracts/swarm-service.ts";
import { managedConsumerRollout } from "../../src/server/deployment/managed-consumer-rollout.ts";
import type { ConsumerBaseline } from "../../src/server/deployment/managed-consumer-rollout.ts";
import { parseManagedGroupPreparation } from "../../src/server/deployment/managed-group-preparation.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";

const checkedPlan = (value: unknown) => { const result = parseManagedApplicationPlan(value); assert.ok(result.ok, result.ok ? "" : result.error); return result.value; };
const fixture = async (t: TestContext, previous: boolean | ((plan: ManagedApplicationPlan) => ManagedApplicationPlan) = false) => {
  const data = await managedPlanFixture(); const plan = checkedPlan({ ...data.plan, rollout: { ...data.plan.rollout, migrations: [] } });
  const old = previous === false ? null : typeof previous === "function" ? previous(plan) : plan;
  const path = await mkdtemp(join(tmpdir(), "kayra-consumers-")); const artifacts = await openArtifactStore(join(path, "artifacts"));
  let journal = await openJournal(path); let clock = 1000; let lost = false; let routesReady = true; let admitted = true; let monitor = false;
  const runtime = new Map<string, ServiceObservation>(); const writes: ManagedServiceAction[] = []; const contexts: string[] = []; const checks: string[] = [];
  const actionFor = (name: string, context: ManagedApplicationPlan, sequence: number) => {
    const service = context.services[name]; assert.ok(service);
    return { app: service.owner.app, incarnation: service.owner.incarnation, dataOwner: service.owner.dataOwner, service: name, action: service.owner.incarnation + ":" + String(sequence), plan: managedServiceDigest(service), deadline: sequence === 1 ? 999 : 91000, effect: "apply" as const };
  };
  const observe = (action: ManagedServiceAction, version = 1) => ({ status: "owned" as const, id: action.service.padEnd(25, "s"), version, action: action.action, effect: action.effect, taskEffect: action.effect, plan: action.plan, taskPlan: action.plan,
    tombstone: false, containersStopped: true, retainedInputsCleared: false, specMatches: true, replicas: 1, endpoint: "vip" as const, update: monitor ? "updating" as const : "completed" as const,
    tasks: [{ id: "t".repeat(25), incarnation: action.incarnation, action: action.action, effect: action.effect, plan: action.plan, desired: "running" as const, state: "running" as const, health: "healthy" as const }] });
  const baseline: ConsumerBaseline[] = old === null ? [] : Object.values(old.services).filter((service) => service.role !== "retained-dependency").map((service) => {
    const action = actionFor(service.service, old, 1); const observed = observe(action); runtime.set(service.service, observed); return { name: service.service, action, native: { id: observed.id, version: observed.version } };
  });
  const db = actionFor("db", plan, 1); runtime.set("db", observe(db));
  const preparation = parseManagedGroupPreparation({ version: 1, app: db.app, incarnation: db.incarnation, dataOwner: db.dataOwner, run: randomUUID(), action: db.incarnation + ":2", plan: managedApplicationDigest(plan),
    createdAt: 1000, startupDeadline: 91000, migrationDeadline: 181000, consumerDeadline: 91000, sequencePlan: null, sequence: null, phase: "ready", reason: null,
    nodes: [{ name: "db", plan: db.plan, baseline: { kind: "active", action: db, native: { id: "db".padEnd(25, "s"), version: 1 } }, execution: null, ready: { action: db, native: { id: "db".padEnd(25, "s"), version: 1 }, at: 1000 } }],
  });
  const ports = { ...artifacts, now: () => clock, authorize: () => Promise.resolve(admitted), services: {
    observe: (scope: { readonly service: string }) => { assert.deepEqual(Object.keys(scope).toSorted(), ["app", "dataOwner", "incarnation", "service"]); return Promise.resolve(runtime.get(scope.service) ?? { status: "absent" as const }); },
    observeDesired: (action: ManagedServiceAction, _spec: unknown, context: ManagedApplicationPlan) => {
      contexts.push(managedApplicationDigest(context)); const observed = runtime.get(action.service); if (observed?.status !== "owned") return Promise.resolve(observed ?? { status: "absent" as const });
      return Promise.resolve({ ...observed, specMatches: observed.plan === action.plan });
    },
    apply: (action: ManagedServiceAction, expected: unknown, _spec: unknown, context: ManagedApplicationPlan) => {
      const current = runtime.get(action.service); assert.deepEqual(expected, current?.status === "owned" ? { id: current.id, version: current.version } : null);
      const description = context.services[action.service]; assert.ok(description); assert.equal(managedServiceDigest(description), action.plan); writes.push(action); runtime.set(action.service, observe(action, current?.status === "owned" ? current.version + 1 : 1));
      return lost ? Promise.reject(new Error("lost native acknowledgement")) : Promise.resolve("acknowledged" as const);
    },
    tombstone: (action: ManagedServiceAction) => {
      writes.push(action); const current = runtime.get(action.service); if (current?.status !== "owned") throw new Error("missing baseline");
      runtime.set(action.service, { ...current, version: current.version + 1, action: action.action, effect: action.effect, taskEffect: action.effect, tombstone: true, containersStopped: true, retainedInputsCleared: action.effect === "scrub", replicas: 0, endpoint: "dnsrr", tasks: [] });
      return Promise.resolve("acknowledged" as const);
    },
  }, readiness: { check: (action: ManagedServiceAction) => { checks.push(action.service); return Promise.resolve({ app: action.app, service: action.service, incarnation: action.incarnation, action: action.action, plan: action.plan, checkedAt: clock, status: routesReady ? "ready" as const : "unready" as const }); } } };
  let owner = managedConsumerRollout(journal, ports);
  t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  const drive = async () => { for (let i = 0; i < 100; i++) { const state = await owner.tick(); if (state.phase !== "updating") return state; } throw new Error("consumers did not settle"); };
  return { plan, old, preparation, baseline, runtime, writes, contexts, checks, ports, owner: () => owner, journal: () => journal, drive,
    prepare: () => owner.prepare(plan, preparation, old, baseline), lose: () => { lost = true; }, monitor: (value: boolean) => { monitor = value; }, routes: (value: boolean) => { routesReady = value; }, deny: () => { admitted = false; }, now: (value: number) => { clock = value; },
    reopen: async () => { await journal.close(); journal = await openJournal(path, "existing"); owner = managedConsumerRollout(journal, ports); },
  };
};

test("consumer group observes interrupted dispatch without replay and verifies every HTTP route before ready", async (t) => {
  const lab = await fixture(t); const initial = await lab.prepare(); lab.lose(); lab.routes(false);
  while (lab.writes.length < 1) await lab.owner().tick();
  await lab.reopen();
  for (let i = 0; i < 20; i++) await lab.owner().tick();
  assert.equal(lab.writes.length, 2); assert.equal((await lab.owner().read())?.phase, "updating");
  assert.ok(lab.checks.every((name) => name === "web")); lab.routes(true);
  const ready = await lab.drive(); assert.equal(ready.phase, "ready"); assert.equal(ready.deadline, initial.deadline); assert.equal(lab.writes.length, 2);
  await lab.reopen(); lab.now(999999); assert.deepEqual(await lab.owner().tick(), ready); assert.equal(lab.writes.length, 2);
});

test("independent consumer services dispatch without waiting for another native monitoring window", async (t) => {
  const lab = await fixture(t); await lab.prepare(); lab.monitor(true);
  for (let i = 0; i < 12 && lab.writes.length < 2; i++) await lab.owner().tick();
  assert.equal(lab.writes.length, 2); assert.equal((await lab.owner().read())?.phase, "updating");
  for (const [name, value] of lab.runtime) if (value.status === "owned") lab.runtime.set(name, { ...value, update: "completed" });
  assert.equal((await lab.drive()).phase, "ready");
});

test("retained health and original deadlines gate all consumer effects after restart", async (t) => {
  const lab = await fixture(t); const initial = await lab.prepare(); const db = lab.runtime.get("db"); assert.ok(db?.status === "owned");
  lab.runtime.set("db", { ...db, tasks: [] }); for (let i = 0; i < 3; i++) await lab.owner().tick(); assert.equal(lab.writes.length, 0);
  await lab.reopen(); lab.now(initial.deadline); const held = await lab.owner().tick(); assert.equal(held.phase, "held"); assert.equal(held.reason, "deadline"); assert.equal(lab.writes.length, 0);
});

test("authorization refusal prevents dispatch and never produces a verified release", async (t) => {
  const lab = await fixture(t); await lab.prepare(); lab.deny(); assert.equal((await lab.drive()).phase, "held"); assert.equal(lab.writes.length, 0);
});

test("old forbidden-overlap workers are drained and scrubbed before changing to allowed overlap", async (t) => {
  const lab = await fixture(t, (plan) => { const worker = plan.services["worker"]; assert.ok(worker); return checkedPlan({ ...plan, services: { ...plan.services, worker: { ...worker, overlap: "forbidden" } } }); });
  // The target fixture is forbidden too: create an allowed target while retaining the old immutable baseline.
  const worker = lab.plan.services["worker"]; assert.ok(worker); const plan = checkedPlan({ ...lab.plan, rollout: { ...lab.plan.rollout, services: { ...lab.plan.rollout.services, worker: { role: "worker", overlap: "allowed" } } }, services: { ...lab.plan.services, worker: { ...worker, overlap: "allowed" } } });
  const prefix = { ...lab.preparation, plan: managedApplicationDigest(plan) };
  await lab.owner().prepare(plan, prefix, lab.old, lab.baseline);
  for (let i = 0; i < 40; i++) { const state = await lab.owner().tick(); if (state.nodes.find((node) => node.name === "worker")?.execution !== null) break; }
  const state = await lab.owner().read(); assert.equal(state?.nodes.find((node) => node.name === "worker")?.quiescence?.phase, "complete");
  const workerWrites = lab.writes.filter((action) => action.service === "worker"); assert.deepEqual(workerWrites.map((action) => action.effect), ["remove", "scrub"]);
  assert.equal((await lab.drive()).phase, "ready"); assert.deepEqual(lab.writes.filter((action) => action.service === "worker").map((action) => action.effect), ["remove", "scrub", "apply"]);
});

test("missing previous consumer refuses replacement instead of creating fresh state", async (t) => {
  const lab = await fixture(t, true); await lab.prepare(); lab.runtime.delete("web");
  assert.equal((await lab.drive()).phase, "held"); assert.equal(lab.writes.some((action) => action.service === "web"), false);
});

test("removed consumers retain a scrubbed name barrier and cannot leave live tasks at group readiness", async (t) => {
  const lab = await fixture(t, true);
  const plan = checkedPlan({ ...lab.plan, services: Object.fromEntries(Object.entries(lab.plan.services).filter(([name]) => name !== "worker")), rollout: { ...lab.plan.rollout, services: Object.fromEntries(Object.entries(lab.plan.rollout.services).filter(([name]) => name !== "worker")) } });
  await lab.owner().prepare(plan, { ...lab.preparation, plan: managedApplicationDigest(plan) }, lab.old, lab.baseline);
  const ready = await lab.drive(); assert.equal(ready.phase, "ready"); const worker = ready.nodes.find((node) => node.name === "worker"); assert.equal(worker?.ready?.kind, "removed");
  assert.deepEqual(lab.writes.filter((action) => action.service === "worker").map((action) => action.effect), ["remove", "scrub"]);
  assert.equal(lab.runtime.get("worker")?.status, "owned");
});

test("dependency edges permit old healthy mixed-version consumers but reject unhealthy ones", async (t) => {
  const lab = await fixture(t, true); const worker = lab.plan.services["worker"]; assert.ok(worker);
  const plan = checkedPlan({ ...lab.plan, services: { ...lab.plan.services, worker: { ...worker, dependencies: [{ service: "web", condition: "healthy" }] } } });
  const web = lab.runtime.get("web"); assert.ok(web?.status === "owned"); lab.runtime.set("web", { ...web, tasks: [] });
  await lab.owner().prepare(plan, { ...lab.preparation, plan: managedApplicationDigest(plan) }, lab.old, lab.baseline);
  await lab.owner().tick(); assert.equal(lab.writes.length, 0); // web slot is prepared, worker must still wait
  for (let i = 0; i < 12; i++) await lab.owner().tick();
  assert.equal(lab.writes[0]?.service, "web"); assert.equal((await lab.drive()).phase, "ready");
});

test("baseline digest and preparation scope disagreement refuse before recording consumer intent", async (t) => {
  const lab = await fixture(t, true); const wrong = lab.baseline.map((value) => ({ ...value, action: { ...value.action, plan: "f".repeat(64) } }));
  await assert.rejects(lab.owner().prepare(lab.plan, lab.preparation, lab.old, wrong), /digest/); assert.equal(await lab.journal().read(), undefined);
  const db = lab.plan.services["db"]; assert.ok(db); const empty = checkedPlan({ ...lab.plan, services: { ...lab.plan.services, db: { ...db, dependencies: [] } } });
  await assert.rejects(lab.owner().prepare(empty, { ...lab.preparation, nodes: [] }, lab.old, lab.baseline), /scope or service set/);
  assert.equal(await lab.journal().read(), undefined); assert.equal(lab.writes.length, 0);
});

test("recreated retained native objects do not inherit the preparation readiness grant", async (t) => {
  const lab = await fixture(t); await lab.prepare(); const database = lab.runtime.get("db"); assert.ok(database?.status === "owned");
  lab.runtime.set("db", { ...database, id: "x".repeat(25) }); for (let i = 0; i < 4; i++) await lab.owner().tick();
  assert.equal(lab.writes.length, 0); lab.now(lab.preparation.consumerDeadline ?? 0); assert.equal((await lab.owner().tick()).reason, "deadline");
});
