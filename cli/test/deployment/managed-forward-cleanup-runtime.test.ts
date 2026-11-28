/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types -- models clocks, platform revocation and separate native capabilities */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedApplicationPlan, managedMigrationDescription } from "../../src/contracts/managed-application-plan.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { managedSourceContext } from "../../src/server/deployment/managed-source-context.ts";
import { parseManagedForwardCleanupContext, managedForwardCleanupServices } from "../../src/contracts/managed-forward-cleanup-context.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import { parseJobPlan } from "../../src/contracts/one-shot-job.ts";
import { managedRuntimeAuthority } from "../../src/server/platform/managed-runtime-authority.ts";
import { managedForwardCleanupRuntime } from "../../src/server/composition/managed-forward-cleanup-runtime.ts";
import type { ManagedRuntimePermission } from "../../src/contracts/managed-runtime-authority.ts";
import type { CheckContainerFencePort } from "../../src/contracts/check-container-fence.ts";

const fixture = async () => {
  const { plan } = await managedPlanFixture(); const candidate = parseManagedApplicationPlan({ ...plan, grants: { ...plan.grants, maintenance: true }, rollout: { ...plan.rollout, strategy: "maintenance", rollback_compatible: false } }); assert.ok(candidate.ok);
  const source = parseManagedLifecycleSource({ version: 1, candidate: candidate.value, previous: null, retained: [], retired: [], run: randomUUID(), action: plan.infrastructure.ownership.incarnation + ":2", createdAt: 1000 });
  const blocked = managedSourceContext(source); const worker = blocked.application.services["worker"]; const db = blocked.application.services["db"]; assert.ok(worker); assert.ok(db);
  const target = { action: { app: blocked.owner.app, incarnation: blocked.owner.incarnation, dataOwner: blocked.owner.dataOwner, service: "worker", action: blocked.action, effect: "apply" as const, plan: managedServiceDigest(worker), deadline: 91000 }, service: "w".repeat(25), task: "t".repeat(25), container: "c".repeat(64) };
  const pinned = target;
  const parsed = parseManagedForwardCleanupContext({ version: 1, protocol: "managed-v3", runtime: "swarm", kind: "forward-cleanup", blocked, run: randomUUID(), action: blocked.owner.incarnation + ":3", source: "e".repeat(64), reservation: "f".repeat(64), createdAt: 2000, deadline: 92000, checks: [{ target: pinned, native: { id: pinned.service, version: 4 } }] }); assert.ok(parsed.ok); const context = parsed.value;
  let clock = 2000; let owned = true; const effects: string[] = []; const permissions: ManagedRuntimePermission[] = [];
  const ports = { now: () => clock, authority: { allowed: (base: typeof blocked, permission: ManagedRuntimePermission) => { assert.deepEqual(base, blocked); permissions.push(permission); return Promise.resolve(owned); } }, native: {
    services: { observe: () => { effects.push("service-observe"); return Promise.resolve({ status: "absent" as const }); }, tombstone: () => { effects.push("service-tombstone"); return Promise.resolve("acknowledged" as const); } },
    jobs: { observe: () => { effects.push("job-observe"); return Promise.resolve({ status: "absent" as const }); } },
    containers: { observe: (request: Parameters<CheckContainerFencePort["observe"]>[0]) => { effects.push("container-observe"); return Promise.resolve({ status: "fenced" as const, kind: "stopped" as const, native: request.native, checkedAt: clock }); } },
  } };
  const action = { app: blocked.owner.app, incarnation: blocked.owner.incarnation, dataOwner: blocked.owner.dataOwner, service: "worker", action: context.action + ":quiesce:remove:1", effect: "remove" as const, plan: managedServiceDigest(worker), deadline: context.deadline };
  const migration = managedMigrationDescription(blocked.application, blocked.run); assert.ok(migration.ok); const step = migration.value.steps[0]; assert.ok(step);
  const job = parseJobPlan({ ...step.template, scope: { ...migration.value.scope, step: step.definition.id, purpose: "migration", attempt: 1 }, command: step.definition.command, deadline: 10000 }); assert.ok(job.ok);
  const fence = { target: pinned, native: { id: pinned.service, version: 6 }, barrier: { ...action, effect: "scrub" as const, action: context.action + ":quiesce:scrub:1" } };
  return { context, blocked, worker, db, action, fence, job: job.value, ports, effects, permissions, clock: (at: number) => { clock = at; }, deny: () => { owned = false; } };
};

test("forward cleanup construction exposes only stop/scrub and read capabilities without requesting secrets or effects", async () => {
  const lab = await fixture(); const runtime = managedForwardCleanupRuntime(lab.context, lab.ports); assert.deepEqual(lab.effects, []); assert.deepEqual(lab.permissions, []);
  assert.deepEqual(Object.keys(runtime.services), ["observe", "tombstone"]); assert.deepEqual(Object.keys(runtime.jobs), ["observe"]); assert.deepEqual(Object.keys(runtime.containers), ["observe"]); assert.deepEqual(managedForwardCleanupServices(lab.context).map((service) => service.service), ["web", "worker"]);
  assert.equal(await runtime.services.tombstone(lab.action, { id: "w".repeat(25), version: 4 }, lab.worker.image), "acknowledged"); assert.deepEqual(lab.effects, ["service-tombstone"]); assert.deepEqual(lab.permissions, [{ kind: "recovery" }]);
});

test("foreign scopes, retained dependencies and non-cleanup actions cannot borrow the successor write capability", async () => {
  const lab = await fixture(); const runtime = managedForwardCleanupRuntime(lab.context, lab.ports);
  for (const action of [{ ...lab.action, action: lab.blocked.action + ":quiesce:remove:1" }, { ...lab.action, action: lab.context.action + ":recover:remove:1" }, { ...lab.action, action: lab.context.action + ":quiesce:remove:9" }, { ...lab.action, effect: "apply" as const }, { ...lab.action, dataOwner: randomUUID() }, { ...lab.action, deadline: lab.action.deadline + 1 }, { ...lab.action, service: "db", plan: managedServiceDigest(lab.db) }]) assert.equal(await runtime.services.tombstone(action, null, lab.worker.image), "refused");
  assert.equal(await runtime.services.tombstone(lab.action, null, "wrong-image"), "refused"); assert.deepEqual(await runtime.services.observe({ ...lab.action, service: "db" }), { status: "foreign" }); assert.deepEqual(lab.effects, []); assert.deepEqual(lab.permissions, []);
});

test("expired cleanup refuses writes while scoped forensic observations remain available", async () => {
  const lab = await fixture(); const runtime = managedForwardCleanupRuntime(lab.context, lab.ports); lab.clock(lab.context.deadline);
  assert.equal(await runtime.services.tombstone(lab.action, null, lab.worker.image), "refused"); assert.deepEqual(await runtime.services.observe(lab.action), { status: "absent" }); assert.deepEqual(await runtime.jobs.observe(lab.job), { status: "absent" }); assert.equal((await runtime.containers.observe(lab.fence)).status, "fenced");
  assert.deepEqual(lab.effects, ["service-observe", "job-observe", "container-observe"]); assert.deepEqual(await runtime.jobs.observe({ ...lab.job, scope: { ...lab.job.scope, run: lab.context.run } }), { status: "unavailable" });
  assert.deepEqual(await runtime.containers.observe({ ...lab.fence, target: { ...lab.fence.target, container: "d".repeat(64) } }), { status: "foreign" }); assert.equal(lab.effects.length, 3);
});

test("lost platform ownership prevents both cleanup writes and native observations", async () => {
  const lab = await fixture(); const runtime = managedForwardCleanupRuntime(lab.context, lab.ports); lab.deny();
  assert.equal(await runtime.services.tombstone(lab.action, null, lab.worker.image), "refused"); assert.deepEqual(await runtime.services.observe(lab.action), { status: "unavailable" }); assert.deepEqual(await runtime.jobs.observe(lab.job), { status: "unavailable" }); assert.deepEqual(await runtime.containers.observe(lab.fence), { status: "unavailable" }); assert.deepEqual(lab.effects, []);
});

test("delayed ownership approval cannot cross the successor deadline or dispatch after its observation window", async (t) => {
  const lab = await fixture(); const late = managedForwardCleanupRuntime(lab.context, { ...lab.ports, authority: { allowed: () => { lab.clock(lab.context.deadline); return Promise.resolve(true); } } });
  assert.equal(await late.services.tombstone(lab.action, null, lab.worker.image), "refused"); lab.clock(2000); t.mock.timers.enable({ apis: ["setTimeout"] }); const entered = Promise.withResolvers<undefined>(); const approval = Promise.withResolvers<boolean>();
  const runtime = managedForwardCleanupRuntime(lab.context, { ...lab.ports, authority: { allowed: () => { entered.resolve(undefined); return approval.promise; } } });
  const result = runtime.services.tombstone(lab.action, null, lab.worker.image); await entered.promise; t.mock.timers.tick(10000); assert.equal(await result, "refused"); approval.resolve(true); await Promise.resolve(); assert.deepEqual(lab.effects, []);
});

test("forward cleanup context rejects another operation, retained check targets and conflicting identity", async () => {
  const lab = await fixture(); const context = lab.context;
  for (const input of [{ ...context, action: context.blocked.action }, { ...context, run: context.blocked.run }, { ...context, deadline: context.deadline + 1 }, { ...context, checks: [...context.checks, ...context.checks] }, { ...context, checks: [{ ...context.checks[0], target: { ...lab.fence.target, action: { ...lab.fence.target.action, service: "db", plan: managedServiceDigest(lab.db) } } }] }]) assert.equal(parseManagedForwardCleanupContext(input).ok, false);
  assert.deepEqual(lab.effects, []);
});

test("the reserved consumer cleanup uses owned recovery permission when current start publications are unavailable", async () => {
  const lab = await fixture(); const authority = managedRuntimeAuthority({ owned: () => Promise.resolve(true), current: () => Promise.resolve(undefined) });
  assert.equal(await authority.allowed(lab.blocked, { kind: "admission" }), false);
  const runtime = managedForwardCleanupRuntime(lab.context, { ...lab.ports, authority }); assert.equal(await runtime.services.tombstone(lab.action, null, lab.worker.image), "acknowledged"); assert.deepEqual(lab.effects, ["service-tombstone"]);
});
