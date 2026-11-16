/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types -- models native effects, accounting and coordinator interruption */
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
import type { ManagedServicePlan } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedServiceAction, ManagedServiceScope } from "../../src/contracts/managed-swarm-service.ts";
import type { ServiceObservation, ServiceVersion } from "../../src/contracts/swarm-service.ts";
import type { ManagedAdmissionPort, ManagedAdmissionIdentity, ManagedAdmissionClaim } from "../../src/contracts/managed-admission.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { managedMigrationInputs } from "../../src/server/deployment/managed-migration-inputs.ts";
import { jobRuntime } from "./one-shot-fixture.ts";
import { jobName } from "../../src/contracts/one-shot-job.ts";
import type { JobPlan } from "../../src/contracts/one-shot-job.ts";
import { managedLifecycleOwner } from "../../src/server/deployment/managed-lifecycle-owner.ts";
import { parseManagedLifecycleStore } from "../../src/server/deployment/managed-lifecycle-store.ts";
import { reserveManagedTransition } from "../../src/server/deployment/managed-transition.ts";
import { parseResourceBook, settleResources } from "../../src/server/deployment/resource-book.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";

const fixture = async (t: TestContext, maintenance = false, migrations: boolean | "unknown" = false) => {
  const { plan } = await managedPlanFixture(); const parsed = parseManagedApplicationPlan({ ...plan, grants: { ...plan.grants, maintenance }, rollout: { ...plan.rollout, strategy: maintenance ? "maintenance" : "rolling", migrations: migrations === "unknown" ? plan.rollout.migrations.map((step) => ({ ...step, recovery: { kind: "status-probe", command: ["node", "status.mjs"], timeout_seconds: 10 } })) : migrations ? plan.rollout.migrations : [] } }); assert.ok(parsed.ok); const candidate = parsed.value;
  const source = parseManagedLifecycleSource({ version: 1, candidate, previous: null, run: randomUUID(), action: candidate.infrastructure.ownership.incarnation + ":2", createdAt: 1000, retained: [], retired: [] });
  const path = await mkdtemp(join(tmpdir(), "kayra-managed-owner-")); const artifacts = await openArtifactStore(join(path, "artifacts")); let journal = await openJournal(path); let clock = 1000; let book: unknown = null; let binding: string | undefined; let reserveCalls = 0; let settleCalls = 0; let loseReserve = false; let loseSettle = false; let authorize = true; let loseJobStart = false;
  const native = new Map<string, ServiceObservation>(); const calls: ManagedServiceAction[] = [];
  const observation = { status: "ready", engine: "29.9.3", api: "1.56", node: candidate.host.node, cluster: candidate.host.cluster, network: candidate.host.network.id, capacity: { cpu: candidate.host.profile.cpu_millicores, memory: candidate.host.profile.memory_bytes }, standing: { cpu: candidate.host.profile.platform_cpu_millicores, memory: candidate.host.profile.platform_memory_bytes } } as const;
  const admission: ManagedAdmissionPort = {
    reserve: (identity: ManagedAdmissionIdentity, claim: ManagedAdmissionClaim) => {
      reserveCalls++; const result = reserveManagedTransition(book, observation, claim, Number(identity.action.split(":")[1]), identity.deadline, clock); if (!result.ok) return Promise.resolve("refused"); book = result.value; binding = JSON.stringify(identity);
      return loseReserve ? Promise.reject(new Error("lost reservation acknowledgement")) : Promise.resolve("reserved");
    },
    observe: (identity) => {
      if (book === null) return Promise.resolve("absent"); if (binding !== JSON.stringify(identity)) return Promise.resolve("foreign"); const checked = parseResourceBook(book); assert.ok(checked.ok); const charge = checked.value.charges[0]; assert.ok(charge);
      return Promise.resolve(charge.result === "pending" ? "reserved" : charge.result === "target" ? "settled-target" : charge.result === "previous" ? "settled-previous" : "settled-absent");
    },
    settle: (identity, _claim, result) => {
      settleCalls++; const next = settleResources(book, identity.owner.app, identity.owner.incarnation, Number(identity.action.split(":")[1]), result); assert.ok(next.ok); book = next.value;
      return loseSettle ? Promise.reject(new Error("lost settlement acknowledgement")) : Promise.resolve("settled");
    },
  };
  const services = {
    observe: (scope: ManagedServiceScope) => Promise.resolve(native.get(scope.service) ?? { status: "absent" as const }),
    observeDesired: (action: ManagedServiceAction, spec: ManagedServicePlan) => { const value = native.get(action.service); return Promise.resolve(value?.status === "owned" ? { ...value, specMatches: value.plan === managedServiceDigest(spec) } : { status: "absent" as const }); },
    apply: async (action: ManagedServiceAction, expected: ServiceVersion | null, spec: ManagedServicePlan) => {
      const ledger = parseResourceBook(book); assert.ok(ledger.ok); assert.equal(ledger.value.charges[0]?.result, "pending"); const state = await owner.read(); assert.ok(state); const effect = spec.role === "retained-dependency" ? state.operation.preparation?.nodes.find((value) => value.name === spec.service)?.execution : state.operation.consumers?.nodes.find((value) => value.name === spec.service)?.execution; assert.equal(effect?.phase, "observing");
      const before = native.get(action.service); assert.equal(expected?.version ?? null, before?.status === "owned" ? before.version : null); calls.push(action);
      native.set(action.service, { status: "owned", id: action.service.padEnd(25, "s"), version: before?.status === "owned" ? before.version + 1 : 1, action: action.action, effect: action.effect, taskEffect: action.effect, plan: action.plan, taskPlan: action.plan, specMatches: true, tombstone: false, retainedInputsCleared: false, containersStopped: false, containersConverged: true, replicas: 1, endpoint: "vip", update: "completed", tasks: [{ id: action.service.padEnd(25, "t"), incarnation: action.incarnation, action: action.action, effect: action.effect, plan: action.plan, desired: "running", state: "running", health: "healthy" }] }); return "acknowledged" as const;
    },
    tombstone: () => Promise.resolve("refused" as const),
  };
  const nodes = new Map<string, ReturnType<typeof jobRuntime>>();
  const nodeFor = (job: JobPlan) => { const name = jobName(job.scope); let value = nodes.get(name); if (value === undefined) { value = jobRuntime(job); nodes.set(name, value); } value.now(clock); return value; };
  const jobs = {
    observe: async (job: JobPlan) => { const value = await nodeFor(job).native.observe(job); return value.status === "owned" && value.state === "succeeded" && job.scope.purpose === "probe" ? { ...value, probe: "unknown" as const } : value; },
    create: (job: JobPlan) => { const database = native.get("db"); assert.equal(database?.status, "owned"); assert.equal(database.tasks[0]?.health, "healthy"); const inputs = managedMigrationInputs(candidate, job); assert.ok(inputs.ok); return nodeFor(job).native.create(job, Object.fromEntries(Object.entries(inputs.value.environment).map(([key, value]) => [key, value.kind === "literal" ? value.value : "PRIVATE_JOB_VALUE"]))); },
    start: async (job: JobPlan, id: string, deadline?: number) => { const state = await owner.read(); assert.equal(state?.operation.preparation?.sequence?.steps[0]?.attempts.at(-1)?.execution?.phase, "start-intent"); const result = await nodeFor(job).native.start(job, id, deadline); if (migrations === "unknown" && job.scope.purpose === "migration") nodeFor(job).state("exited", 1); if (loseJobStart) throw new Error("lost migration Start acknowledgement"); return result; },
    fence: (job: JobPlan, id: string | null, deadline: number) => nodeFor(job).native.fence(job, id, deadline),
  };
  const ports = { ...artifacts, now: () => clock, admission, services, authorize: () => Promise.resolve(authorize), jobs, readiness: { check: (action: ManagedServiceAction) => Promise.resolve({ app: action.app, incarnation: action.incarnation, service: action.service, action: action.action, plan: action.plan, checkedAt: clock, status: "ready" as const }) } };
  let resolutionCut: "before" | "after" | null = null;
  const view = () => ({ read: journal.read, write: async (raw: Parameters<typeof journal.write>[0]) => {
    const auditing = parseManagedLifecycleStore(raw).operation.preparation?.sequence?.steps.some((step) => step.resolution !== undefined) ?? false;
    if (auditing && resolutionCut === "before") throw new Error("injected before audit write"); await journal.write(raw); if (auditing && resolutionCut === "after") throw new Error("injected lost audit acknowledgement");
  } });
  let owner = managedLifecycleOwner(view(), candidate.infrastructure.ownership, ports);
  t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  return { source, calls, nodes, loseJobStart: () => { loseJobStart = true; }, owner: () => owner, reserveCalls: () => reserveCalls, settleCalls: () => settleCalls, book: () => book, clock: (value: number) => { clock = value; }, loseReserve: () => { loseReserve = true; }, loseSettle: () => { loseSettle = true; }, deny: () => { authorize = false; },
    cutResolution: (where: "before" | "after") => { resolutionCut = where; },
    reopen: async () => { await journal.close(); journal = await openJournal(path, "existing"); resolutionCut = null; owner = managedLifecycleOwner(view(), candidate.infrastructure.ownership, ports); },
    drive: async () => { for (let i = 0; i < 100; i++) { const value = await owner.tick(); if (value?.operation.phase === "complete" || value?.operation.phase === "held") return value; } throw new Error("managed lifecycle did not settle"); },
  };
};

for (const maintenance of [false, true]) test(`${maintenance ? "maintenance" : "rolling"} lifecycle owns admission, child intents, whole-plan promotion and capacity settlement`, async (t) => {
  const lab = await fixture(t, maintenance); await lab.owner().begin(lab.source); const first = lab.owner().tick(); assert.strictEqual(lab.owner().tick(), first); await first;
  const done = await lab.drive(); assert.equal(done.operation.phase, "complete"); assert.ok(done.active); assert.equal(lab.calls.length, 3); assert.equal(lab.reserveCalls(), 1); assert.equal(lab.settleCalls(), 1);
  await lab.reopen(); lab.clock(999999); assert.deepEqual(await lab.owner().begin(lab.source), done); assert.equal((await lab.owner().tick())?.operation.phase, "complete"); assert.equal(lab.calls.length, 3);
});

test("lost reservation acknowledgement is reconstructed before any native effect without another reservation", async (t) => {
  const lab = await fixture(t); await lab.owner().begin(lab.source); lab.loseReserve(); await lab.owner().tick(); assert.equal(lab.calls.length, 0); await lab.reopen(); assert.equal((await lab.drive()).operation.phase, "complete"); assert.equal(lab.reserveCalls(), 1);
});

test("lost resource settlement acknowledgement leaves active promotion durable and reconstructs settlement without native redispatch", async (t) => {
  const lab = await fixture(t); await lab.owner().begin(lab.source); lab.loseSettle();
  for (let i = 0; i < 100; i++) { await lab.owner().tick(); if (lab.settleCalls() > 0) break; }
  const before = await lab.owner().read(); assert.equal(before?.operation.phase, "settling"); assert.ok(before.active); await lab.reopen(); lab.clock(999999); assert.equal((await lab.owner().tick())?.operation.phase, "complete"); assert.equal(lab.settleCalls(), 1); assert.equal(lab.calls.length, 3);
});

test("interruption between phase handoff and preparation intent cannot mint a fresh scheduling window", async (t) => {
  const lab = await fixture(t); await lab.owner().begin(lab.source); await lab.owner().tick(); const admitted = await lab.owner().tick(); assert.equal(admitted?.operation.phase, "preparing"); assert.equal(admitted.operation.preparation, null);
  await lab.reopen(); lab.clock(admitted.operation.enteredAt + 90000); const held = await lab.owner().tick(); assert.equal(held?.operation.phase, "held"); assert.equal(held.operation.reason, "deadline"); assert.equal(lab.calls.length, 0);
});

test("cancellation before native effects holds the operation and its pending resource charge rather than inventing cleanup", async (t) => {
  const lab = await fixture(t); await lab.owner().begin(lab.source); await lab.owner().tick(); await lab.owner().cancel(); const held = await lab.owner().tick(); assert.equal(held?.operation.phase, "held"); assert.equal(held.operation.reason, "cancellation"); assert.equal(held.active, null); assert.equal(lab.settleCalls(), 0); assert.equal(lab.calls.length, 0);
});

test("revoking operator authority after admission prevents retained startup and preserves the pending charge", async (t) => {
  const lab = await fixture(t); await lab.owner().begin(lab.source); await lab.owner().tick(); await lab.owner().tick(); lab.deny();
  const held = await lab.drive(); assert.equal(held.operation.phase, "held"); assert.equal(held.active, null); assert.equal(lab.calls.length, 0); assert.equal(lab.settleCalls(), 0);
  const book = parseResourceBook(lab.book()); assert.ok(book.ok); assert.equal(book.value.charges[0]?.result, "pending");
});


test("migration Start interruption resumes its owned outcome and original deadlines before any consumer update", async (t) => {
  const lab = await fixture(t, false, true); await lab.owner().begin(lab.source); lab.loseJobStart(); await assert.rejects(lab.drive(), /lost migration Start acknowledgement/);
  const before = await lab.owner().read(); assert.ok(before?.operation.preparation?.sequence); const deadline = before.operation.preparation.migrationDeadline; const executionDeadline = before.operation.preparation.sequence.steps[0]?.executionDeadline;
  assert.deepEqual(lab.calls.map((action) => action.service), ["db"]); await lab.reopen(); const done = await lab.drive(); assert.equal(done.operation.phase, "complete");
  assert.equal(done.operation.preparation?.migrationDeadline, deadline); assert.equal(done.operation.preparation.sequence?.steps[0]?.executionDeadline, executionDeadline); assert.equal([...lab.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 1);
  assert.equal(JSON.stringify(done).includes("PRIVATE_JOB_VALUE"), false); assert.equal(lab.calls.length, 3);
});

const actor = { kind: "operator-control", identity: "lab-operator" } as const;
const resolution = (run: string, outcome: "applied" | "not-applied" = "applied") => ({ app: "shop", run, step: "schema", outcome, reason: "Operator inspected the application migration ledger" });

test("audited applied resolution resumes the connected owner without replaying ambiguous migration or probe", async (t) => {
  const lab = await fixture(t, false, "unknown"); await lab.owner().begin(lab.source); const held = await lab.drive(); assert.equal(held.operation.phase, "held"); assert.equal(held.operation.preparation?.sequence?.reason, "probe-unknown");
  const evidence = JSON.stringify(held.operation.preparation.sequence.steps[0]?.attempts); const deadline = held.operation.deadline;
  const resolved = await lab.owner().resolveMigration(resolution(lab.source.run), actor); assert.equal(resolved.receipt.disposition, "continue"); assert.equal(resolved.state.operation.phase, "preparing");
  await lab.reopen(); const done = await lab.drive(); assert.equal(done.operation.phase, "complete"); assert.equal(done.operation.deadline, deadline);
  assert.equal(JSON.stringify(done.operation.preparation?.sequence?.steps[0]?.attempts), evidence); assert.equal([...lab.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 2);
  const replay = await lab.owner().resolveMigration(resolution(lab.source.run), actor); assert.deepEqual(replay.receipt, resolved.receipt); assert.deepEqual(replay.state, done);
  await assert.rejects(lab.owner().resolveMigration(resolution(lab.source.run, "not-applied"), actor), /already resolved differently/);
});

test("not-applied and late applied assertions stay held, retain capacity and cannot promote or grant a new deadline", async (t) => {
  for (const late of [false, true]) {
    const lab = await fixture(t, false, "unknown"); await lab.owner().begin(lab.source); const held = await lab.drive();
    if (late) lab.clock(held.operation.deadline + 1);
    const resolved = await lab.owner().resolveMigration(resolution(lab.source.run, late ? "applied" : "not-applied"), actor);
    assert.equal(resolved.receipt.disposition, "failed"); assert.equal(resolved.state.operation.phase, "held"); assert.equal(resolved.state.operation.deadline, held.operation.deadline); assert.equal(resolved.state.active, null); assert.equal(lab.settleCalls(), 0);
    assert.deepEqual(lab.calls.map((action) => action.service), ["db"]); await lab.reopen(); assert.equal((await lab.owner().tick())?.operation.phase, "held");
  }
});

test("migration resolution requires current authority and cannot bypass cancellation or another run", async (t) => {
  const lab = await fixture(t, false, "unknown"); await lab.owner().begin(lab.source); const held = await lab.drive();
  await assert.rejects(lab.owner().resolveMigration(resolution(randomUUID()), actor), /ownership/); lab.deny();
  await assert.rejects(lab.owner().resolveMigration(resolution(lab.source.run), actor), /not authorized/); assert.deepEqual(await lab.owner().read(), held);
  await lab.owner().cancel(); await assert.rejects(lab.owner().resolveMigration(resolution(lab.source.run), actor), /ownership/);
});

for (const cut of ["before", "after"] as const) test(`reopen ${cut} the resolution journal replacement preserves one audit and does not replay unsafe work`, async (t) => {
  const lab = await fixture(t, false, "unknown"); await lab.owner().begin(lab.source); const held = await lab.drive(); lab.cutResolution(cut);
  await assert.rejects(lab.owner().resolveMigration(resolution(lab.source.run), actor), /synchronization uncertain/); await lab.reopen();
  const restored = await lab.owner().read(); assert.equal(restored?.operation.deadline, held.operation.deadline);
  assert.equal(restored.operation.phase, cut === "before" ? "held" : "preparing");
  const resolved = await lab.owner().resolveMigration(resolution(lab.source.run), actor); const done = await lab.drive(); assert.equal(done.operation.phase, "complete");
  assert.equal(done.operation.preparation?.sequence?.steps[0]?.resolution?.id, resolved.receipt.resolution); assert.equal([...lab.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 2);
});
