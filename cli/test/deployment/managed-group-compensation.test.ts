/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- models native services, delayed convergence and process restart */
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
import { managedServiceDigest, managedServiceName } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedServiceAction, ManagedServiceScope } from "../../src/contracts/managed-swarm-service.ts";
import type { ManagedServicePlan } from "../../src/contracts/managed-service-plan.ts";
import type { ServiceObservation, ServiceVersion } from "../../src/contracts/swarm-service.ts";
import { parseManagedGroupPreparation } from "../../src/server/deployment/managed-group-preparation.ts";
import { parseManagedGroupCompensation, managedGroupCompensation } from "../../src/server/deployment/managed-group-compensation.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";

const fixture = async (t: TestContext, first = false) => {
  const data = await managedPlanFixture(); const oldChecked = parseManagedApplicationPlan({ ...data.plan, rollout: { ...data.plan.rollout, migrations: [] } }); assert.ok(oldChecked.ok); const previous = first ? null : oldChecked.value;
  const db = oldChecked.value.services["db"]; const worker = oldChecked.value.services["worker"]; assert.ok(db); assert.ok(worker);
  const checked = parseManagedApplicationPlan({ ...oldChecked.value, services: { ...oldChecked.value.services, cache: { ...db, service: "cache", nativeName: managedServiceName(db.owner, "cache") }, extra: { ...worker, service: "extra", nativeName: managedServiceName(worker.owner, "extra") } }, rollout: { ...oldChecked.value.rollout, services: { ...oldChecked.value.rollout.services, cache: { role: "retained-dependency", overlap: "forbidden" }, extra: { role: "worker", overlap: "forbidden" } } } }); assert.ok(checked.ok); const candidate = checked.value;
  const path = await mkdtemp(join(tmpdir(), "kayra-group-compensation-")); const artifacts = await openArtifactStore(join(path, "artifacts")); let journal = await openJournal(path); let clock = 1000; let lost = false; let monitoring = false; let routes = true; let admitted = true; let corrupt = false; let uncertain = false;
  const runtime = new Map<string, ServiceObservation>(); const effects: ManagedServiceAction[] = [];
  const actionFor = (spec: ManagedServicePlan, sequence = 1) => ({ app: spec.owner.app, incarnation: spec.owner.incarnation, dataOwner: spec.owner.dataOwner, service: spec.service, action: spec.owner.incarnation + ":" + String(sequence), plan: managedServiceDigest(spec), effect: "apply" as const, deadline: sequence === 1 ? 999 : 91000 });
  const observedFor = (action: ManagedServiceAction, version: number) => ({ status: "owned" as const, id: action.service.padEnd(25, "s"), version, action: action.action, effect: action.effect, taskEffect: action.effect, plan: action.plan, taskPlan: action.plan, tombstone: false, retainedInputsCleared: false, specMatches: true, replicas: 1, endpoint: "vip" as const, update: monitoring ? "updating" as const : "completed" as const,
    tasks: [{ id: "t".repeat(25), incarnation: action.incarnation, action: action.action, effect: action.effect, plan: action.plan, desired: "running" as const, state: "running" as const, health: "healthy" as const }] });
  for (const spec of Object.values(candidate.services)) runtime.set(spec.service, observedFor(actionFor(spec), 1));
  const baselines = Object.values(previous?.services ?? {}).filter((spec) => spec.role !== "retained-dependency").map((spec) => ({ name: spec.service, action: actionFor(spec), native: { id: spec.service.padEnd(25, "s"), version: 1 } }));
  const prefix = parseManagedGroupPreparation({ version: 1, app: db.owner.app, incarnation: db.owner.incarnation, dataOwner: db.owner.dataOwner, run: randomUUID(), action: db.owner.incarnation + ":2", plan: managedApplicationDigest(candidate), createdAt: 1000, startupDeadline: 91000, migrationDeadline: 181000, consumerDeadline: null, sequencePlan: null, sequence: null, phase: "dependencies", reason: null,
    nodes: Object.values(candidate.services).filter((spec) => spec.role === "retained-dependency").map((spec) => ({ name: spec.service, plan: managedServiceDigest(spec), baseline: !first && spec.service === "db" ? { kind: "active", action: actionFor(spec), native: { id: spec.service.padEnd(25, "s"), version: 1 } } : null, execution: null, ready: null })),
  });
  const ports = { ...artifacts, read: (digest: string) => corrupt ? Promise.resolve("{}") : artifacts.read(digest), now: () => clock, authorize: () => Promise.resolve(admitted), services: {
    observe: (scope: ManagedServiceScope) => { assert.deepEqual(Object.keys(scope).toSorted(), ["app", "dataOwner", "incarnation", "service"]); return Promise.resolve(runtime.get(scope.service) ?? { status: "absent" as const }); },
    observeDesired: (action: ManagedServiceAction) => { const observed = runtime.get(action.service); return Promise.resolve(observed?.status === "owned" ? { ...observed, specMatches: observed.plan === action.plan } : observed ?? { status: "absent" as const }); },
    apply: (action: ManagedServiceAction, expected: ServiceVersion | null, _spec: ManagedServicePlan, context: ManagedApplicationPlan) => {
      assert.ok(previous); assert.equal(managedApplicationDigest(context), managedApplicationDigest(previous)); const observed = runtime.get(action.service); assert.ok(observed?.status === "owned"); assert.deepEqual(expected, { id: observed.id, version: observed.version }); effects.push(action); runtime.set(action.service, observedFor(action, observed.version + 1)); return lost ? Promise.reject(new Error("lost group restore acknowledgement")) : Promise.resolve("acknowledged" as const);
    },
    fence: (action: ManagedServiceAction, expected: ServiceVersion) => { const observed = runtime.get(action.service); assert.ok(observed?.status === "owned"); assert.equal(expected.version, observed.version); effects.push(action); runtime.set(action.service, { ...observed, version: observed.version + 1, action: action.action, effect: "fence" }); return Promise.resolve("acknowledged" as const); },
    tombstone: (action: ManagedServiceAction, expected: ServiceVersion | null) => { const observed = runtime.get(action.service); assert.ok(observed?.status === "owned"); assert.deepEqual(expected, { id: observed.id, version: observed.version }); effects.push(action); runtime.set(action.service, { ...observed, version: observed.version + 1, action: action.action, plan: action.plan, effect: action.effect, taskEffect: action.effect, tombstone: true, retainedInputsCleared: action.effect === "scrub", replicas: 0, endpoint: "dnsrr", tasks: [] }); return Promise.resolve("acknowledged" as const); },
  }, readiness: { check: (action: ManagedServiceAction) => Promise.resolve({ app: action.app, service: action.service, incarnation: action.incarnation, action: action.action, plan: action.plan, checkedAt: clock, status: routes ? "ready" as const : "unready" as const }) } };
  const view = () => ({ read: journal.read, write: async (value: Parameters<typeof journal.write>[0]) => { await journal.write(value); const state = parseManagedGroupCompensation(value);
    if (uncertain && state.nodes.some((node) => node.child?.attempts.some((attempt) => attempt.phase === "observing"))) throw new Error("lost synchronized group restore intent acknowledgement");
  } });
  let owner = managedGroupCompensation(view(), ports); t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  const input = { candidate, previous, preparation: prefix, consumers: null, baselines };
  const drive = async () => { for (let i = 0; i < 200; i++) { const state = await owner.tick(); if (state.phase !== "recovering") return state; } throw new Error("group compensation did not settle"); };
  return { input, effects, runtime, owner: () => owner, journal: () => journal, prepare: () => owner.prepare(input), drive, lose: () => { lost = true; }, monitor: () => { monitoring = true; }, routes: (value: boolean) => { routes = value; }, deny: () => { admitted = false; }, now: (value: number) => { clock = value; },
    corrupt: () => { corrupt = true; }, uncertain: () => { uncertain = true; },
    reopen: async () => { await journal.close(); journal = await openJournal(path, "existing"); uncertain = false; owner = managedGroupCompensation(view(), ports); },
  };
};

test("whole-group recovery restores previous consumers and scrubs new-only workers and retained services", async (t) => {
  const lab = await fixture(t); const initial = await lab.prepare(); lab.lose(); lab.routes(false);
  for (let i = 0; i < 100; i++) await lab.owner().tick(); const pending = await lab.owner().read(); assert.equal(pending?.phase, "recovering"); assert.ok(pending.nodes.every((node) => node.child?.phase === "complete"));
  await lab.reopen(); lab.routes(true); const done = await lab.drive(); assert.equal(done.phase, "verified"); assert.equal(done.deadline, initial.deadline);
  assert.deepEqual(lab.effects.filter((action) => action.effect === "restore").map((action) => action.service).toSorted(), ["web", "worker"]);
  for (const name of ["cache", "extra"]) assert.deepEqual(lab.effects.filter((action) => action.service === name).map((action) => action.effect), ["remove", "scrub"]);
  assert.equal(lab.effects.some((action) => action.service === "db"), false); lab.now(999999); assert.deepEqual(await lab.owner().tick(), done);
});

test("independent restorations overlap native monitoring without renewing the root deadline", async (t) => {
  const lab = await fixture(t); await lab.prepare(); lab.monitor();
  for (let i = 0; i < 70 && lab.effects.filter((action) => action.effect === "restore").length < 2; i++) await lab.owner().tick();
  assert.equal(lab.effects.filter((action) => action.effect === "restore").length, 2);
  for (const [name, observed] of lab.runtime) if (observed.status === "owned") lab.runtime.set(name, { ...observed, update: "completed" });
  assert.equal((await lab.drive()).phase, "verified");
});

test("initial cleanup stops dependent consumers before scrubbing their retained database", async (t) => {
  const lab = await fixture(t, true); await lab.prepare(); const done = await lab.drive(); assert.equal(done.phase, "verified"); assert.equal(done.previous, null);
  const firstDatabase = lab.effects.findIndex((action) => action.service === "db");
  for (const name of ["web", "worker", "extra"]) assert.ok(lab.effects.findIndex((action) => action.service === name && action.effect === "scrub") < firstDatabase);
  assert.equal(lab.effects.some((action) => action.effect === "restore"), false);
});

test("expired or revoked root authority cannot mutate or certify a recovered group", async (t) => {
  const lab = await fixture(t); const initial = await lab.prepare(); await lab.reopen(); lab.now(initial.deadline); assert.equal((await lab.owner().tick()).reason, "deadline"); assert.equal(lab.effects.length, 0);
  const denied = await fixture(t); await denied.prepare(); denied.deny(); assert.equal((await denied.drive()).phase, "held"); assert.equal(denied.effects.length, 0);
});

test("corrupted immutable recovery input refuses effects after restart", async (t) => {
  const lab = await fixture(t); await lab.prepare(); await lab.reopen(); lab.corrupt(); await assert.rejects(lab.owner().tick(), /source unavailable/); assert.equal(lab.effects.length, 0);
});

test("the root snapshots recovery inputs before queuing and cannot certify late routed evidence", async (t) => {
  const lab = await fixture(t); const web = lab.input.candidate.services["web"]; assert.ok(web);
  const candidate = { ...lab.input.candidate, services: { ...lab.input.candidate.services, web: { ...web, resources: { ...web.resources } } } };
  const pending = lab.owner().prepare({ ...lab.input, candidate }); candidate.services.web.resources.memoryBytes++;
  const initial = await pending; assert.equal(initial.plan, managedApplicationDigest(lab.input.candidate)); lab.routes(false);
  for (let i = 0; i < 100; i++) await lab.owner().tick(); assert.equal((await lab.owner().read())?.phase, "recovering");
  lab.routes(true); lab.now(initial.deadline); const held = await lab.owner().tick(); assert.equal(held.phase, "held"); assert.equal(held.verifiedAt, null);
});

test("an uncertain group write poisons the live owner and restart reconciles pending restore authority", async (t) => {
  const lab = await fixture(t); const initial = await lab.prepare(); lab.uncertain(); await assert.rejects(lab.drive(), /uncertain/); const effects = lab.effects.length;
  await assert.rejects(lab.owner().tick(), /reopen/); assert.equal(lab.effects.length, effects);
  await lab.reopen(); const done = await lab.drive(); assert.equal(done.phase, "verified"); assert.equal(done.deadline, initial.deadline);
  assert.equal(lab.effects.filter((action) => action.service === "web" && action.effect === "restore").length, 1);
});
