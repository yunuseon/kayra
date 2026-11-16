/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- owns fake native state and restart handles */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedServiceAction, ManagedServiceScope } from "../../src/contracts/managed-swarm-service.ts";
import type { ServiceObservation, ServiceVersion } from "../../src/contracts/swarm-service.ts";
import { managedMaintenanceQuiescence, managedMaintenanceSnapshot } from "../../src/server/deployment/managed-maintenance-quiescence.ts";
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
  return { request, calls, reads, observed, owner: () => owner, journal: () => journal, clock: (value: number) => { clock = value; }, deny: () => { admitted = false; }, lose: () => { lose = true; },
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
  const old = lab.observed.get("web"); assert.ok(old?.status === "owned"); lab.observed.set("web", { ...old, action: old.action + "other" });
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
