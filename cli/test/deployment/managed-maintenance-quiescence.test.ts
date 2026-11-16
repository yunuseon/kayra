/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- owns fake native state and restart handles */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import type { ManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { managedConsumerRollout } from "../../src/server/deployment/managed-consumer-rollout.ts";
import { managedGroupVerification } from "../../src/server/deployment/managed-group-verification.ts";
import type { ManagedServicePlan } from "../../src/contracts/managed-service-plan.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedServiceAction, ManagedServiceScope } from "../../src/contracts/managed-swarm-service.ts";
import type { ServiceObservation, ServiceVersion } from "../../src/contracts/swarm-service.ts";
import { managedMaintenanceQuiescence, managedMaintenanceSnapshot } from "../../src/server/deployment/managed-maintenance-quiescence.ts";
import { managedMigrationInputs } from "../../src/server/deployment/managed-migration-inputs.ts";
import { managedGroupPreparation } from "../../src/server/deployment/managed-group-preparation.ts";
import type { JobPlan } from "../../src/contracts/one-shot-job.ts";
import { jobName } from "../../src/contracts/one-shot-job.ts";
import { jobRuntime } from "./one-shot-fixture.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";

const fixture = async (t: TestContext) => {
  const { plan } = await managedPlanFixture(); assert.ok(plan.services["web"]);
  const parsed = parseManagedApplicationPlan({ ...plan, services: { ...plan.services, web: { ...plan.services["web"], dependencies: [{ service: "worker", condition: "healthy" }] } } }); assert.ok(parsed.ok); const previous = parsed.value;
  const next = parseManagedApplicationPlan({ ...previous, grants: { ...previous.grants, maintenance: true }, rollout: { ...previous.rollout, strategy: "maintenance", mixed_version_compatible: false, rollback_compatible: false } }); assert.ok(next.ok); const candidate = next.value;
  const baselines = Object.values(previous.services).filter((service) => service.role !== "retained-dependency").map((service, index) => ({ name: service.service,
    action: { app: service.owner.app, service: service.service, incarnation: service.owner.incarnation, dataOwner: service.owner.dataOwner, action: service.owner.incarnation + ":2", plan: managedServiceDigest(service), deadline: 91000, effect: "apply" as const }, native: { id: String.fromCharCode(115 + index).repeat(25), version: 5 }, prior: [] }));
  const request = { candidate, previous, baselines, action: previous.infrastructure.ownership.incarnation + ":3", run: randomUUID(), startedAt: 1000 };
  const observed = new Map<string, ServiceObservation>(baselines.map((node) => [node.name, { status: "owned", ...node.native, action: node.action.action, plan: node.action.plan, effect: "apply", taskEffect: "apply", taskPlan: node.action.plan, tombstone: false, retainedInputsCleared: false, specMatches: null, replicas: 1, endpoint: "vip", update: "completed", tasks: [] }]));
  const path = await mkdtemp(join(tmpdir(), "kayra-maintenance-")); const artifacts = await openArtifactStore(join(path, "artifacts")); let journal = await openJournal(path); let clock = 1000; let admitted = true; let lose = false;
  const calls: ManagedServiceAction[] = []; const reads: string[] = [];
  const ports = { ...artifacts, now: () => clock, authorize: () => Promise.resolve(admitted), services: {
    observe: (scope: ManagedServiceScope) => { reads.push(scope.service); return Promise.resolve(observed.get(scope.service) ?? { status: "absent" as const }); },
    tombstone: (action: ManagedServiceAction, expected: ServiceVersion | null) => {
      calls.push(action); const before = observed.get(action.service); assert.ok(before?.status === "owned"); assert.deepEqual(expected, { id: before.id, version: before.version });
      observed.set(action.service, { ...before, action: action.action, plan: action.plan, effect: action.effect, version: before.version + 1, replicas: 0, endpoint: "dnsrr", tombstone: true, retainedInputsCleared: action.effect === "scrub" });
      return lose ? Promise.reject(new Error("lost native reply")) : Promise.resolve("acknowledged" as const);
    },
  } };
  let owner = managedMaintenanceQuiescence(journal, ports);
  t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  return { request, calls, reads, observed, ports, path, now: () => clock, owner: () => owner, journal: () => journal, clock: (value: number) => { clock = value; }, deny: () => { admitted = false; }, lose: () => { lose = true; },
    reopen: async () => { await journal.close(); journal = await openJournal(path, "existing"); owner = managedMaintenanceQuiescence(journal, ports); },
    finish: async () => { for (let i = 0; i < 20; i++) { const state = await owner.tick(); if (state.phase !== "quiescing") return state; } throw new Error("maintenance did not finish"); },
  };
};

test("maintenance drains consumers in reverse dependency order, preserving retained services and every old CAS", async (t) => {
  const lab = await fixture(t); const initial = await lab.owner().prepare(lab.request); lab.lose();
  await lab.owner().tick(); await lab.owner().tick(); await lab.reopen(); const done = await lab.finish();
  assert.equal(done.phase, "complete"); assert.equal(done.deadline, initial.deadline);
  assert.deepEqual(lab.calls.map((call) => call.service + ":" + call.effect), ["web:remove", "web:scrub", "worker:remove", "worker:scrub"]);
  assert.ok(lab.calls.every((call) => call.action.includes(":3:quiesce:"))); assert.ok(!lab.reads.includes("db"));
  assert.ok(done.nodes.every((node) => node.child?.proof?.native.version === 7));
  lab.clock(999999); await lab.reopen(); assert.deepEqual(await lab.owner().prepare(lab.request), done); assert.equal(lab.calls.length, 4);
});

test("maintenance grant and complete previous consumer coverage are required before intent", async (t) => {
  const lab = await fixture(t);
  for (const input of [{ ...lab.request, candidate: lab.request.previous }, { ...lab.request, baselines: lab.request.baselines.slice(1) }, { ...lab.request, baselines: [...lab.request.baselines, lab.request.baselines[0]] }]) {
    assert.throws(() => lab.owner().prepare(input)); assert.equal(await lab.journal().read(), undefined);
  }
  assert.equal(lab.calls.length, 0);
});

test("an interrupted quiescence cannot acquire a new deadline or redispatch an unchanged old CAS", async (t) => {
  const lab = await fixture(t); await lab.owner().prepare(lab.request); await lab.owner().tick();
  const initial = await lab.owner().read(); assert.ok(initial); const node = initial.nodes[0]; assert.ok(node?.child);
  await lab.journal().write({ ...initial, nodes: initial.nodes.map((value, index) => index === 0 ? { ...value, child: { ...node.child, steps: [{ effect: "remove", attempt: 1, expected: node.baseline }] } } : value) });
  await lab.reopen(); await lab.owner().tick(); assert.equal(lab.calls.length, 0);
  lab.clock(initial.deadline); const expired = await lab.owner().tick(); assert.equal(expired.phase, "held"); assert.equal(expired.reason, "deadline");
  await lab.reopen(); assert.deepEqual(await lab.owner().tick(), expired); assert.equal(lab.calls.length, 0);
});

test("authorization loss holds quiescence without stopping a consumer", async (t) => {
  const lab = await fixture(t); await lab.owner().prepare(lab.request); lab.deny(); assert.equal((await lab.owner().tick()).reason, "authorization"); assert.equal(lab.calls.length, 0);
});

test("a changed native consumer after its barrier cannot become a maintenance completion certificate", async (t) => {
  const lab = await fixture(t); await lab.owner().prepare(lab.request);
  for (let i = 0; i < 12; i++) { const state = await lab.owner().tick(); if (state.nodes.every((node) => node.child?.phase === "complete")) break; }
  const old = lab.observed.get("web"); assert.ok(old?.status === "owned"); lab.observed.set("web", { ...old, action: String(old.action) + "other" });
  const held = await lab.owner().tick(); assert.equal(held.phase, "held"); assert.equal(held.reason, "runtime"); assert.equal(held.verifiedAt, null);
});

test("initial maintenance deployment records an empty quiescence phase without runtime effects", async (t) => {
  const lab = await fixture(t); await lab.owner().prepare({ ...lab.request, previous: null, baselines: [] }); assert.equal((await lab.owner().tick()).phase, "complete"); assert.equal(lab.calls.length, 0); assert.equal(lab.reads.length, 0);
});

test("a draining dependent prevents its dependency from being stopped", async (t) => {
  const lab = await fixture(t); await lab.owner().prepare(lab.request); await lab.owner().tick(); await lab.owner().tick();
  const before = lab.observed.get("web"); assert.ok(before?.status === "owned"); lab.observed.set("web", { ...before, tasks: [{ id: "x".repeat(25), effect: "apply", incarnation: lab.request.previous.infrastructure.ownership.incarnation, action: lab.request.baselines[0]?.action.action ?? "", plan: before.plan, desired: "shutdown", state: "running", health: "healthy" }] });
  await lab.reopen(); for (let i = 0; i < 3; i++) await lab.owner().tick();
  assert.deepEqual(lab.calls.map((call) => call.service), ["web"]);
  const draining = lab.observed.get("web"); assert.ok(draining?.status === "owned"); lab.observed.set("web", { ...draining, tasks: [] }); assert.equal((await lab.finish()).phase, "complete");
});

test("maintenance cannot change retained engines or reinterpret a consumer as a retained dependency", async (t) => {
  const lab = await fixture(t); const db = lab.request.candidate.services["db"]; assert.ok(db);
  const changed = parseManagedApplicationPlan({ ...lab.request.candidate, services: { ...lab.request.candidate.services, db: { ...db, resources: { ...db.resources, memoryBytes: db.resources.memoryBytes + 1 } } } }); assert.ok(changed.ok);
  assert.throws(() => lab.owner().prepare({ ...lab.request, candidate: changed.value }), /service coverage/); assert.equal(await lab.journal().read(), undefined); assert.equal(lab.calls.length, 0);
});


test("maintenance handoff evidence is bound to its immutable source and complete phase", async (t) => {
  const lab = await fixture(t); await lab.owner().prepare(lab.request); const done = await lab.finish();
  const snapshot = managedMaintenanceSnapshot({ certificate: done, source: lab.request }); assert.equal(snapshot.certificate.phase, "complete");
  for (const certificate of [{ ...done, run: randomUUID() }, { ...done, plan: "a".repeat(64) }, { ...done, nodes: [] }]) assert.throws(() => managedMaintenanceSnapshot({ certificate, source: lab.request }), /integrity/);
});


const maintenancePreparation = async (t: TestContext, adjust?: (plan: ManagedApplicationPlan) => ManagedApplicationPlan) => {
  const lab = await fixture(t); if (adjust !== undefined) lab.request.candidate = adjust(lab.request.candidate); await lab.owner().prepare(lab.request); const certificate = await lab.finish();
  const db = lab.request.previous.services["db"]; assert.ok(db);
  const action: ManagedServiceAction = { app: db.owner.app, incarnation: db.owner.incarnation, dataOwner: db.owner.dataOwner, service: "db", action: db.owner.incarnation + ":2", plan: managedServiceDigest(db), effect: "apply", deadline: 91000 };
  const native = { id: "d".repeat(25), version: 5 };
  lab.observed.set("db", { status: "owned", ...native, action: action.action, plan: action.plan, effect: "apply", taskEffect: "apply", taskPlan: action.plan, tombstone: false, retainedInputsCleared: false, specMatches: true, replicas: 1, endpoint: "vip", update: "completed", tasks: [{ id: "t".repeat(25), desired: "running", state: "running", health: "healthy", effect: "apply", incarnation: db.owner.incarnation, action: action.action, plan: action.plan }] });
  const nodes = new Map<string, ReturnType<typeof jobRuntime>>();
  const nodeFor = (job: JobPlan) => { const key = jobName(job.scope); let node = nodes.get(key); if (node === undefined) { node = jobRuntime(job); nodes.set(key, node); } node.now(lab.now()); return node; };
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(lab.path, "preparation")));
  let journal = await openJournal(join(lab.path, "preparation"));
  const ports = { ...lab.ports, services: { ...lab.ports.services, observeDesired: (action: ManagedServiceAction) => Promise.resolve(lab.observed.get(action.service) ?? { status: "absent" as const }), apply: () => { throw new Error("unchanged database must not be recreated"); } }, jobs: {
    observe: (job: JobPlan) => nodeFor(job).native.observe(job), create: (job: JobPlan) => { const inputs = managedMigrationInputs(lab.request.candidate, job); assert.ok(inputs.ok); return nodeFor(job).native.create(job, Object.fromEntries(Object.entries(inputs.value.environment).map(([key, binding]) => [key, binding.kind === "literal" ? binding.value : "PRIVATE"]))); }, start: (job: JobPlan, id: string, deadline?: number) => nodeFor(job).native.start(job, id, deadline), fence: (job: JobPlan, id: string | null, deadline: number) => nodeFor(job).native.fence(job, id, deadline),
  } };
  let owner = managedGroupPreparation(journal, ports); t.after(() => journal.close());
  const proof = { certificate, source: lab.request };
  return { ...lab, nodes, proof, preparationPorts: ports, prepare: () => owner.prepare(lab.request.candidate, lab.request.run, lab.request.action, [{ name: "db", kind: "active", action, native }], proof), preparation: () => owner,
    reopenPreparation: async () => { await journal.close(); journal = await openJournal(join(lab.path, "preparation"), "existing"); owner = managedGroupPreparation(journal, ports); },
  };
};

test("maintenance migration preparation consumes a source-bound quiescence certificate and keeps its phase deadline through reopen", async (t) => {
  const lab = await maintenancePreparation(t); const initial = await lab.prepare(); assert.equal(initial.version, 2); assert.equal(initial.createdAt, lab.proof.certificate.verifiedAt);
  for (let i = 0; i < 100; i++) { const state = await lab.preparation().tick(); assert.notEqual(state.phase, "held"); if (state.phase === "ready") break; }
  assert.equal((await lab.preparation().read())?.phase, "ready"); assert.equal([...lab.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 1);
  await lab.reopenPreparation(); lab.clock(999999); assert.equal((await lab.prepare()).startupDeadline, initial.startupDeadline); assert.equal((await lab.preparation().tick()).phase, "ready");
});

test("a revived consumer invalidates maintenance authority before migration Start", async (t) => {
  const lab = await maintenancePreparation(t); await lab.prepare();
  for (let i = 0; i < 80; i++) { const state = await lab.preparation().tick(); if ([...lab.nodes.values()].some((node) => node.raw() !== undefined)) break; assert.notEqual(state.phase, "held"); }
  assert.equal(lab.nodes.size, 1); assert.equal([...lab.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 0);
  const old = lab.observed.get("web"); assert.ok(old?.status === "owned"); lab.observed.set("web", { ...old, replicas: 1 });
  for (let i = 0; i < 10; i++) { const state = await lab.preparation().tick(); if (state.phase === "held") break; }
  assert.equal([...lab.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 0);
  assert.equal((await lab.preparation().read())?.phase, "held");
});

test("maintenance preparation rejects missing or mismatched quiescence before intent and cannot renew an expired handoff", async (t) => {
  const lab = await maintenancePreparation(t);
  await assert.rejects(lab.preparation().prepare(lab.request.candidate, lab.request.run, lab.request.action, []), /quiescence/);
  await assert.rejects(lab.preparation().prepare(lab.request.candidate, randomUUID(), lab.request.action, [], lab.proof), /quiescence/);
  assert.equal(await lab.preparation().read(), undefined);
  lab.clock((lab.proof.certificate.verifiedAt ?? 0) + 90000);
  await assert.rejects(lab.prepare(), /scheduling deadline/); assert.equal(await lab.preparation().read(), undefined); assert.equal(lab.nodes.size, 0);
});


const maintenanceConsumers = async (t: TestContext, adjust?: (plan: ManagedApplicationPlan) => ManagedApplicationPlan) => {
  const lab = await maintenancePreparation(t, adjust); await lab.prepare();
  for (let i = 0; i < 100; i++) { const state = await lab.preparation().tick(); assert.notEqual(state.phase, "held"); if (state.phase === "ready") break; }
  const prefix = await lab.preparation().read(); assert.ok(prefix?.phase === "ready");
  const fs = await import("node:fs/promises"); await fs.mkdir(join(lab.path, "consumers")); let journal = await openJournal(join(lab.path, "consumers"));
  const writes: ManagedServiceAction[] = [];
  const ports = { ...lab.preparationPorts, services: { ...lab.preparationPorts.services, apply: (action: ManagedServiceAction, expected: ServiceVersion | null, service: ManagedServicePlan, context: ManagedApplicationPlan) => {
    assert.deepEqual(context, lab.request.candidate); assert.equal(service.role === "retained-dependency", false); const before = lab.observed.get(action.service); assert.equal(before?.status, "owned"); assert.equal(before.replicas, 0); assert.ok(before.retainedInputsCleared); assert.deepEqual(expected, { id: before.id, version: before.version });
    writes.push(action); lab.observed.set(action.service, { ...before, version: before.version + 1, action: action.action, effect: action.effect, taskEffect: action.effect, taskPlan: action.plan, plan: action.plan, tombstone: false, retainedInputsCleared: false, specMatches: true, replicas: 1, endpoint: "vip", tasks: [{ id: action.service.padEnd(25, "t"), desired: "running", state: "running", health: "healthy", effect: action.effect, incarnation: action.incarnation, action: action.action, plan: action.plan }] }); return Promise.resolve("acknowledged" as const);
  } }, readiness: { check: (action: ManagedServiceAction) => Promise.resolve({ app: action.app, service: action.service, incarnation: action.incarnation, action: action.action, plan: action.plan, checkedAt: lab.now(), status: "ready" as const }) } };
  let owner = managedConsumerRollout(journal, ports); t.after(() => journal.close());
  const references = lab.request.baselines.map(({ name, action, native }) => ({ name, action, native }));
  return { ...lab, writes, consumerPorts: ports, prefix, consumers: () => owner, begin: () => owner.prepare(lab.request.candidate, prefix, lab.request.previous, references),
    reopenConsumers: async () => { await journal.close(); journal = await openJournal(join(lab.path, "consumers"), "existing"); owner = managedConsumerRollout(journal, ports); },
    finishConsumers: async () => { for (let i = 0; i < 100; i++) { const state = await owner.tick(); if (state.phase !== "updating") return state; } throw new Error("maintenance consumers did not settle"); },
  };
};

test("maintenance restarts consumers from their verified barriers in target dependency order and independently verifies the whole plan", async (t) => {
  const lab = await maintenanceConsumers(t); const initial = await lab.begin(); assert.equal(initial.version, 2);
  await lab.consumers().tick(); await lab.reopenConsumers(); const done = await lab.finishConsumers(); assert.equal(done.phase, "ready"); assert.deepEqual(lab.writes.map((action) => action.service), ["worker", "web"]);
  assert.ok(done.nodes.every((node) => node.quiescence === null)); assert.ok(done.nodes.every((node) => node.baseline?.action.action.endsWith(":2"))); assert.equal(done.deadline, initial.deadline);
  const fs = await import("node:fs/promises"); await fs.mkdir(join(lab.path, "verification")); const journal = await openJournal(join(lab.path, "verification")); t.after(() => journal.close());
  const verify = managedGroupVerification(journal, lab.consumerPorts); await verify.prepare({ kind: "deployment", application: lab.request.candidate, certificate: done }); assert.equal((await verify.tick()).phase, "verified");
  lab.clock(999999); await lab.reopenConsumers(); assert.deepEqual(await lab.begin(), done); assert.equal(lab.writes.length, 2);
});

test("maintenance can remove a stopped old-only consumer without replaying its earlier barrier or changing its historical baseline", async (t) => {
  const lab = await maintenanceConsumers(t, (plan) => {
    const { worker: _worker, ...services } = plan.services; const { worker: _role, ...roles } = plan.rollout.services; const web = services["web"]; assert.ok(web);
    const checked = parseManagedApplicationPlan({ ...plan, services: { ...services, web: { ...web, dependencies: [{ service: "db", condition: "healthy" }] } }, rollout: { ...plan.rollout, services: roles } }); assert.ok(checked.ok); return checked.value;
  }); await lab.begin(); const done = await lab.finishConsumers(); assert.equal(done.phase, "ready"); assert.deepEqual(lab.writes.map((action) => action.service), ["web"]);
  const removed = done.nodes.find((node) => node.name === "worker"); assert.equal(removed?.ready?.kind, "removed"); assert.equal(removed?.quiescence, null); assert.equal(lab.calls.length, 4);
});

test("a replaced external maintenance barrier holds startup before any candidate consumer effect", async (t) => {
  const lab = await maintenanceConsumers(t); await lab.begin(); const old = lab.observed.get("worker"); assert.ok(old?.status === "owned"); lab.observed.set("worker", { ...old, action: lab.request.action + ":scrub:1" });
  const result = await lab.finishConsumers(); assert.equal(result.phase, "held"); assert.equal(lab.writes.length, 0);
});


test("explicit maintenance may revoke an old consumer secret without reading or restarting its previous specification", async (t) => {
  const lab = await maintenanceConsumers(t, (plan) => {
    const web = plan.services["web"]; assert.ok(web); const { TOKEN: _token, ...environment } = web.inputs.environment;
    const checked = parseManagedApplicationPlan({ ...plan, secrets: [], services: { ...plan.services, web: { ...web, inputs: { ...web.inputs, environment } } } }); assert.ok(checked.ok); return checked.value;
  }); await lab.begin(); const done = await lab.finishConsumers(); assert.equal(done.phase, "ready"); assert.equal(lab.writes.length, 2);
  assert.ok(lab.writes.every((action) => action.action === lab.request.action));
});
