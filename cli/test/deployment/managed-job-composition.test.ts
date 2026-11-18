import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types -- models changing authority, private inputs and native calls */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedExecutionContext } from "../../src/contracts/managed-execution-context.ts";
import { managedJobs } from "../../src/server/composition/managed-jobs.ts";
import { serviceInputValues } from "../../src/server/platform/service-inputs.ts";
import type { JobPort, JobPlan } from "../../src/contracts/one-shot-job.ts";
import { typed } from "../../src/lib/typed.ts";
import type { RuntimeInputsPort } from "../../src/contracts/service-inputs.ts";
import { err, ok } from "../../src/lib/result.ts";

const fixture = async () => {
  const { plan } = await managedPlanFixture(); const run = randomUUID(); const context = parseManagedExecutionContext({ version: 1, protocol: "managed-v3", runtime: "swarm", owner: plan.infrastructure.ownership, run, action: plan.infrastructure.ownership.incarnation + ":2", source: "e".repeat(64), application: plan, previous: null, allocationRequired: true, createdAt: 1000, admissionDeadline: 91000, deadline: 901000 }); assert.ok(context.ok);
  const service = plan.services["web"]; const migration = plan.rollout.migrations[0]; assert.ok(service && migration);
  const job = typed<JobPlan>({ version: 1, scope: { app: service.owner.app, incarnation: service.owner.incarnation, run, step: migration.id, purpose: "migration", attempt: 1 }, command: migration.command, image: service.image, entrypoint: service.entrypoint, environment: service.inputs.environment, resources: { memoryBytes: service.resources.memoryBytes, nanoCpus: service.resources.nanoCpus }, networks: [service.privateNetwork.id], stopGraceSeconds: service.stopGraceSeconds, deadline: 121000, startDeadline: 91000, executionTimeoutSeconds: 30 });
  let reads = 0; let allowed = true; let cleanup = true; let now = 1000; const calls: string[] = []; const values: Readonly<Record<string, string>>[] = [];
  const native = typed<JobPort>({ observe: () => { calls.push("observe"); return Promise.resolve({ status: "absent" }); }, create: (_, environment) => { calls.push("create"); values.push(environment); return Promise.resolve("acknowledged"); }, start: () => { calls.push("start"); return Promise.resolve("acknowledged"); }, fence: () => { calls.push("fence"); return Promise.resolve("acknowledged"); } });
  const environment = serviceInputValues((reference) => { reads++; return Promise.resolve({ configurationIdentity: reference.configurationIdentity, configuration: { MODE: "synthetic-config" }, secrets: { TOKEN: "synthetic-private-token" }, secretKeys: ["TOKEN"] }); });
  const ports = { now: () => now, environment, allowed: (_context: typeof context.value, _job: JobPlan, effect: "observe" | "create" | "start" | "fence") => Promise.resolve(effect === "observe" || effect === "fence" ? cleanup : allowed) };
  return { context: context.value, job, native, ports, calls, values, reads: () => reads, deny: () => { allowed = false; }, denyCleanup: () => { cleanup = false; }, clock: (value: number) => { now = value; } };
};

test("run-bound jobs materialize private values only at native Create and preserve immutable descriptions", async () => {
  const lab = await fixture(); const runtime = managedJobs(lab.context, lab.native, lab.ports); const before = JSON.stringify([lab.context, lab.job]);
  assert.equal(await runtime.create(lab.job), "acknowledged"); assert.equal(lab.values[0]?.["TOKEN"], "synthetic-private-token"); assert.equal(lab.values[0]["MODE"], "synthetic-config"); assert.equal(lab.reads(), 1);
  assert.equal(await runtime.start(lab.job, "a".repeat(64), 31000), "acknowledged"); assert.equal(lab.reads(), 1); assert.equal(JSON.stringify([lab.context, lab.job]), before); assert.equal(before.includes("synthetic-private-token"), false);
});

test("foreign run, changed command and extended deadline refuse before private input or native access", async () => {
  const lab = await fixture(); const runtime = managedJobs(lab.context, lab.native, lab.ports);
  for (const job of [{ ...lab.job, scope: { ...lab.job.scope, run: randomUUID() } }, { ...lab.job, command: ["/other"] }, { ...lab.job, deadline: lab.context.deadline + 1 }]) assert.equal(await runtime.create(job), "refused");
  assert.equal(lab.reads(), 0); assert.deepEqual(lab.calls, []);
});

test("revoked start authority and expired scheduling windows retain separately authorized cleanup", async () => {
  const lab = await fixture(); const runtime = managedJobs(lab.context, lab.native, lab.ports); lab.deny();
  assert.equal(await runtime.create(lab.job), "refused"); assert.equal(await runtime.start(lab.job, "a".repeat(64)), "refused"); lab.clock((lab.job.startDeadline ?? lab.job.deadline) + 1);
  assert.deepEqual(await runtime.observe(lab.job), { status: "absent" }); assert.equal(await runtime.fence(lab.job, "a".repeat(64), lab.job.deadline + 10000), "acknowledged"); assert.equal(lab.reads(), 0); assert.deepEqual(lab.calls, ["observe", "fence"]);
  lab.denyCleanup(); assert.equal(await runtime.fence(lab.job, null, lab.job.deadline + 10000), "refused");
});

test("permission loss or private input errors cannot reach native Create or disclose private failures", async () => {
  const lab = await fixture(); let checks = 0; const revoked = managedJobs(lab.context, lab.native, { ...lab.ports, allowed: () => Promise.resolve(++checks === 1) });
  assert.equal(await revoked.create(lab.job), "refused"); assert.equal(lab.reads(), 1); assert.deepEqual(lab.calls, []);
  const failed = managedJobs(lab.context, lab.native, { ...lab.ports, environment: { materialize: () => Promise.resolve(err("synthetic-private-token must not escape")) } }); assert.equal(await failed.create(lab.job), "refused"); assert.deepEqual(lab.calls, []);
});

test("permission resolving after the original scheduling window cannot dispatch a job", async () => {
  const lab = await fixture(); const runtime = managedJobs(lab.context, lab.native, { ...lab.ports, allowed: () => { lab.clock(lab.job.startDeadline ?? lab.job.deadline); return Promise.resolve(true); } });
  assert.equal(await runtime.create(lab.job), "refused"); assert.equal(lab.reads(), 0); assert.deepEqual(lab.calls, []);
});

test("declared status probes use the same run-bound input selection and uncertain Create acknowledgement stays uncertain", async () => {
  const lab = await fixture(); const original = lab.context.application; const application = parseManagedApplicationPlan({ ...original, rollout: { ...original.rollout, migrations: original.rollout.migrations.map((step) => ({ ...step, recovery: { kind: "status-probe", command: ["/status"], timeout_seconds: 10 } })) } }); assert.ok(application.ok);
  const context = parseManagedExecutionContext({ ...lab.context, application: application.value }); assert.ok(context.ok);
  const runtime = managedJobs(context.value, lab.native, lab.ports); const probe = { ...lab.job, scope: { ...lab.job.scope, purpose: "probe" as const }, command: ["/status"], executionTimeoutSeconds: 10, deadline: 101000 };
  assert.equal(await runtime.create(probe), "acknowledged"); assert.equal(lab.values[0]?.["TOKEN"], "synthetic-private-token");
  const uncertain = managedJobs(lab.context, { ...lab.native, create: () => Promise.reject(new Error("synthetic-private-token must not escape")) }, lab.ports); assert.equal(await uncertain.create(lab.job), "uncertain");
});

test("stalled permission and private input reads are bounded and late values never dispatch Create", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const stage of ["permission", "inputs"] as const) {
    const lab = await fixture(); const entered = Promise.withResolvers<undefined>(); const permission = Promise.withResolvers<boolean>(); const input = Promise.withResolvers<Awaited<ReturnType<RuntimeInputsPort["materialize"]>>>();
    const runtime = managedJobs(lab.context, lab.native, { ...lab.ports,
      allowed: () => { if (stage === "permission") { entered.resolve(undefined); return permission.promise; } return Promise.resolve(true); },
      environment: { materialize: () => { entered.resolve(undefined); return input.promise; } },
    });
    const call = runtime.create(lab.job); await entered.promise; t.mock.timers.tick(10_000); assert.equal(await call, "refused"); assert.deepEqual(lab.calls, []);
    permission.resolve(true); input.resolve(ok(Object.freeze({ TOKEN: "synthetic-private-token" }))); await Promise.resolve(); await Promise.resolve(); assert.deepEqual(lab.calls, []);
  }
});
