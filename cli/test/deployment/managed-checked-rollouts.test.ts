/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- models application standby/leadership and native service observations */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedServicePlan } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedServiceAction, ManagedServiceScope } from "../../src/contracts/managed-swarm-service.ts";
import type { ServiceObservation } from "../../src/contracts/swarm-service.ts";
import { managedGroupPreparation } from "../../src/server/deployment/managed-group-preparation.ts";
import { managedConsumerRollout } from "../../src/server/deployment/managed-consumer-rollout.ts";
import { managedGroupVerification } from "../../src/server/deployment/managed-group-verification.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";

const fixture = async (t: TestContext, capable = true, active = false) => {
  const data = await managedPlanFixture(); const worker = data.plan.services["worker"]; assert.ok(worker);
  const checked = parseManagedApplicationPlan({ ...data.plan, services: { ...data.plan.services, worker: { ...worker, role: "singleton", overlap: "coordinated", handoffCheck: "handoff" } }, rollout: { ...data.plan.rollout, migrations: [], services: { ...data.plan.rollout.services, worker: { role: "singleton", overlap: "coordinated", handoff_check: "handoff" } }, checks: [{ id: "handoff", service: "worker", command: ["node", "/handoff-complete.js"], timeout_seconds: 2 }] } }); assert.ok(checked.ok); const plan = checked.value;
  const path = await mkdtemp(join(tmpdir(), "kayra-checked-rollout-")); const artifacts = await openArtifactStore(join(path, "artifacts"));
  const directories = ["prepare", "consume", "verify"].map((name) => join(path, name)); await Promise.all(directories.map((directory) => mkdir(directory)));
  const journals = await Promise.all(directories.map((directory) => openJournal(directory))); t.after(async () => { for (const journal of journals) await journal.close(); await rm(path, { recursive: true, force: true }); });
  const preparationJournal = journals[0]; const consumerJournal = journals[1]; const verificationJournal = journals[2]; assert.ok(preparationJournal); assert.ok(consumerJournal); assert.ok(verificationJournal);
  const services = new Map<string, ServiceObservation>(); const effects: ManagedServiceAction[] = []; let checkStarts = 0; let exitCode = 0;
  const checks = {
    select: (action: ManagedServiceAction, native: { readonly id: string }, task: string) => Promise.resolve({ status: "owned" as const, target: { action, service: native.id, task, container: "c".repeat(64) } }),
    create: () => Promise.resolve({ status: "created" as const, id: "e".repeat(64) }),
    start: () => { checkStarts++; exitCode = active ? 0 : 7; return Promise.resolve("acknowledged" as const); },
    observe: () => Promise.resolve({ status: "owned" as const, id: "e".repeat(64), running: false, exitCode }),
  };
  const ports = { ...artifacts, now: () => 1000, authorize: () => Promise.resolve(true), checks: capable ? checks : undefined, services: {
    observe: (scope: ManagedServiceScope) => Promise.resolve(services.get(scope.service) ?? { status: "absent" as const }),
    observeDesired: (action: ManagedServiceAction) => { const observed = services.get(action.service); return Promise.resolve(observed?.status === "owned" ? { ...observed, specMatches: observed.plan === action.plan } : observed ?? { status: "absent" as const }); },
    apply: (action: ManagedServiceAction, _expected: unknown, spec: ManagedServicePlan) => {
      assert.equal(action.plan, managedServiceDigest(spec)); effects.push(action);
      services.set(action.service, { status: "owned", id: action.service.padEnd(25, "s"), version: 1, action: action.action, effect: action.effect, taskEffect: action.effect, plan: action.plan, taskPlan: action.plan, specMatches: true, tombstone: false, containersConverged: true, containersStopped: true, retainedInputsCleared: false, replicas: 1, endpoint: "vip", update: "completed",
        tasks: [{ id: action.service.padEnd(25, "t"), incarnation: action.incarnation, action: action.action, effect: action.effect, plan: action.plan, desired: "running", state: "running", health: "healthy" }] });
      return Promise.resolve("acknowledged" as const);
    },
    tombstone: () => Promise.resolve("refused" as const), fence: () => Promise.resolve("refused" as const),
  }, jobs: { observe: () => Promise.resolve({ status: "unavailable" as const }), create: () => Promise.resolve("refused" as const), start: () => Promise.resolve("refused" as const), fence: () => Promise.resolve("refused" as const) },
    readiness: { check: (action: ManagedServiceAction) => Promise.resolve({ app: action.app, service: action.service, incarnation: action.incarnation, action: action.action, plan: action.plan, checkedAt: 1000, status: "ready" as const }) },
  };
  const preparation = managedGroupPreparation(preparationJournal, ports); const consumers = managedConsumerRollout(consumerJournal, ports); const verification = managedGroupVerification(verificationJournal, ports);
  const prepare = () => preparation.prepare(plan, randomUUID(), plan.infrastructure.ownership.incarnation + ":2", []);
  const drive = async () => {
    await prepare();
    for (let i = 0; i < 30; i++) { const state = await preparation.tick(); if (state.phase === "ready") { await consumers.prepare(plan, state, null, []); break; } assert.notEqual(state.phase, "held"); }
    for (let i = 0; i < 30; i++) { const state = await consumers.tick(); if (state.phase === "ready") { await verification.prepare({ kind: "deployment", application: plan, certificate: state }); break; } assert.notEqual(state.phase, "held"); }
    for (let i = 0; i < 30; i++) { const state = await verification.tick(); if (state.phase !== "running") return state; } throw new Error("checked rollout did not settle");
  };
  return { preparationJournal, consumerJournal, verificationJournal, prepare, drive, effects, checkStarts: () => checkStarts, consumers, verification };
};

test("coordinated singleton health alone cannot certify application handoff", async (t) => {
  const lab = await fixture(t); const result = await lab.drive(); assert.equal((await lab.consumers.read())?.phase, "ready"); assert.equal(result.phase, "held"); assert.equal(result.reason, "check-failed"); assert.equal(result.verified, null); assert.equal(lab.checkStarts(), 1);
});

test("a declared completion check can verify coordinated singleton leadership after native convergence", async (t) => {
  const lab = await fixture(t, true, true); const result = await lab.drive(); assert.equal(result.phase, "verified"); assert.equal(lab.checkStarts(), 1); assert.deepEqual(result.verified?.observations.map((item) => item.name), ["db", "web", "worker"]);
});

test("missing concrete check capability refuses coordinated work before intent or effects", async (t) => {
  const lab = await fixture(t, false); await assert.rejects(lab.prepare(), /capabilities/); assert.equal(await lab.preparationJournal.read(), undefined); assert.equal(await lab.consumerJournal.read(), undefined); assert.equal(await lab.verificationJournal.read(), undefined); assert.equal(lab.effects.length, 0);
});
