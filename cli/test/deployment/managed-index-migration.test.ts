/* eslint-disable functional/no-let, functional/immutable-data -- models app services and native one-shot outcomes, not coordinator state */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedIndexFixture } from "./managed-index-fixture.ts";
import { jobRuntime } from "./one-shot-fixture.ts";
import { jobName } from "../../src/contracts/one-shot-job.ts";
import type { JobPlan } from "../../src/contracts/one-shot-job.ts";
import type { ServiceObservation } from "../../src/contracts/swarm-service.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedWorkloadPort } from "../../src/contracts/managed-workloads.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { managedReleaseBaselines, parseManagedRelease } from "../../src/server/deployment/managed-release.ts";
import type { IndexedManagedRuntime } from "../../src/server/deployment/indexed-managed-lifecycle.ts";
import { typed } from "../../src/lib/typed.ts";

test("indexed migration audit survives completion and a newer run without replaying an unsafe job", async (t) => {
  const lab = await managedIndexFixture(t); const candidate = parseManagedApplicationPlan({ ...lab.plan, rollout: { ...lab.plan.rollout, migrations: lab.plan.rollout.migrations.map((step) => ({ ...step, recovery: { kind: "status-probe", command: ["/status"], timeout_seconds: 10 } })) } }); assert.ok(candidate.ok);
  const source = parseManagedLifecycleSource({ ...lab.source, candidate: candidate.value }); const services = new Map<string, ServiceObservation>(); const jobs = new Map<string, ReturnType<typeof jobRuntime>>();
  const node = (job: JobPlan) => { const key = jobName(job.scope); let value = jobs.get(key); if (value === undefined) { value = jobRuntime(job); jobs.set(key, value); } return value; };
  const unreachable = () => Promise.reject(new Error("unexpected workload cleanup"));
  const workloads = typed<ManagedWorkloadPort>({
    observe: (scope) => Promise.resolve(services.get(scope.service) ?? { status: "absent" }),
    observeDesired: (action, spec) => { const value = services.get(action.service); return Promise.resolve(value?.status === "owned" ? { ...value, specMatches: value.plan === managedServiceDigest(spec) } : { status: "absent" }); },
    apply: async (action, expected) => {
      assert.equal((await lab.index().resourceSnapshot())?.charges[0]?.result, "pending"); const before = services.get(action.service); assert.equal(expected?.version ?? null, before?.status === "owned" ? before.version : null);
      services.set(action.service, { status: "owned", id: action.service.padEnd(25, "s"), version: before?.status === "owned" ? before.version + 1 : 1, action: action.action, effect: action.effect, taskEffect: action.effect, plan: action.plan, taskPlan: action.plan, specMatches: true, tombstone: false, retainedInputsCleared: false, containersStopped: false, containersConverged: true, replicas: 1, endpoint: "vip", update: "completed", tasks: [{ id: action.service.padEnd(25, "t"), incarnation: action.incarnation, action: action.action, effect: action.effect, plan: action.plan, desired: "running", state: "running", health: "healthy" }] }); return "acknowledged";
    }, tombstone: unreachable, fence: unreachable,
  });
  const runtime = typed<IndexedManagedRuntime>({ ...lab.runtime, services: workloads,
    jobs: {
      observe: async (job) => { const value = await node(job).native.observe(job); return value.status === "owned" && value.state === "succeeded" && job.scope.purpose === "probe" ? { ...value, probe: "unknown" } : value; },
      create: (job) => node(job).native.create(job, Object.fromEntries(Object.entries(job.environment).map(([key, value]) => [key, value.kind === "literal" ? value.value : "INDEX_PRIVATE_VALUE"]))),
      start: async (job, id, deadline) => { const value = await node(job).native.start(job, id, deadline); if (job.scope.purpose === "migration") node(job).state("exited", 1); return value; },
      fence: (job, id, deadline) => node(job).native.fence(job, id, deadline),
    },
    readiness: { check: (action) => Promise.resolve({ app: action.app, incarnation: action.incarnation, service: action.service, action: action.action, plan: action.plan, checkedAt: 1000, status: "ready" }) },
  });
  await lab.index().requestManagedDeployment("shop", source, runtime);
  for (let count = 0; count < 100; count++) { const value = await lab.index().tickManagedDeployment("shop", source.run, runtime); if (value?.operation.phase === "held") break; }
  const held = await lab.index().managedState("shop", runtime); assert.equal(held?.operation.phase, "held"); assert.equal(held.operation.preparation?.sequence?.reason, "probe-unknown"); assert.equal(held.active, null);
  const heldStatus = await lab.index().managedDeploymentStatus("shop", runtime); assert.equal(heldStatus?.requiredAction, "inspect-and-resolve"); assert.equal(heldStatus.verifiedActive, null); assert.equal(heldStatus.migrations.step, "schema"); assert.equal(heldStatus.migrations.reason, "probe-unknown"); assert.equal(heldStatus.operation.deadline, held.operation.deadline);
  const assertion = { app: "shop", run: source.run, step: "schema", outcome: "applied", reason: "Fixture operator verified the application-owned migration outcome" } as const; const actor = { kind: "operator-control", identity: "index-test-operator" } as const;
  const resolved = await lab.index().resolveManagedMigration("shop", assertion, actor, runtime); assert.equal(resolved.receipt.disposition, "continue"); await lab.reopen();
  for (let count = 0; count < 100; count++) { const value = await lab.index().tickManagedDeployment("shop", source.run, runtime); if (value?.operation.phase === "complete") break; }
  const completed = await lab.index().managedState("shop", runtime); assert.equal(completed?.operation.phase, "complete"); assert.ok(completed.active); const executions = [...jobs.values()].reduce((total, value) => total + value.executions(), 0); assert.equal(executions, 2);
  const promoted = await lab.index().managedDeploymentStatus("shop", runtime); assert.equal(promoted?.verifiedActive?.run, source.run); assert.equal(promoted.runtimeObservation, "not-observed"); assert.equal(promoted.migrations.resolutions[0]?.id, resolved.receipt.resolution); assert.deepEqual(promoted.desired, promoted.requested);
  const previous = parseManagedRelease(JSON.parse(await lab.artifacts.read(completed.active.record))); const retained = managedReleaseBaselines(previous).filter((value) => previous.source.application.services[value.name]?.role === "retained-dependency").map((value) => ({ ...value, kind: "active" as const }));
  const next = parseManagedLifecycleSource({ ...source, previous, retained, run: randomUUID(), action: lab.incarnation + ":3" }); await lab.index().requestManagedDeployment("shop", next, runtime); await lab.index().cancelManagedDeployment("shop", next.run, runtime); await lab.index().tickManagedDeployment("shop", next.run, runtime); await lab.index().tickManagedDeployment("shop", next.run, runtime); await lab.reopen();
  const current = await lab.index().managedState("shop", runtime); assert.equal(current?.operation.run, next.run); assert.equal(current.operation.phase, "complete");
  const unchanged = await lab.index().managedDeploymentStatus("shop", runtime); assert.equal(unchanged?.operation.outcome, "unchanged"); assert.deepEqual(unchanged.verifiedActive, promoted.verifiedActive); assert.equal(unchanged.operation.run, next.run); assert.equal(unchanged.verifiedActive.run, source.run);
  const activeRecord = completed.active.record;
  await assert.rejects(lab.index().managedDeploymentStatus("shop", { ...runtime, read: (digest) => digest === activeRecord ? Promise.resolve("{}") : runtime.read(digest) }), /evidence is unavailable/);
  const replay = await lab.index().resolveManagedMigration("shop", assertion, actor, runtime); assert.deepEqual(replay.receipt, resolved.receipt); assert.equal(replay.state.operation.run, source.run); assert.deepEqual(await lab.index().managedState("shop", runtime), current);
  await assert.rejects(lab.index().resolveManagedMigration("shop", { ...assertion, reason: "A different assertion must not replace the recorded audit" }, actor, runtime), /conflicts/);
  lab.deny(); await assert.rejects(lab.index().resolveManagedMigration("shop", assertion, actor, runtime), /not authorized/); assert.equal([...jobs.values()].reduce((total, value) => total + value.executions(), 0), executions);
});
