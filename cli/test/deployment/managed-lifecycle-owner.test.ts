/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types -- models native effects, accounting and coordinator interruption */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import type { ManagedChecksPort, ContainerCheckPlan } from "../../src/contracts/container-check.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { managedServiceDigest, managedServiceName } from "../../src/contracts/managed-service-plan.ts";
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
import { parseManagedRelease, managedReleaseBaselines } from "../../src/server/deployment/managed-release.ts";
import { reserveManagedTransition } from "../../src/server/deployment/managed-transition.ts";
import { parseResourceBook, settleResources } from "../../src/server/deployment/resource-book.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";

const fixture = async (t: TestContext, maintenance = false, migrations: boolean | "unknown" = false, unsafe = false, checked = false) => {
  const { plan } = await managedPlanFixture(); const parsed = parseManagedApplicationPlan({ ...plan, grants: { ...plan.grants, maintenance }, rollout: { ...plan.rollout, checks: checked ? [{ id: "verify", service: "worker", command: ["node", "verify.mjs"], timeout_seconds: 2 }] : [], strategy: maintenance ? "maintenance" : "rolling", rollback_compatible: !unsafe, migrations: migrations === "unknown" ? plan.rollout.migrations.map((step) => ({ ...step, recovery: { kind: "status-probe", command: ["node", "status.mjs"], timeout_seconds: 10 } })) : migrations ? plan.rollout.migrations : [] } }); assert.ok(parsed.ok); const candidate = parsed.value;
  const source = parseManagedLifecycleSource({ version: 1, candidate, previous: null, run: randomUUID(), action: candidate.infrastructure.ownership.incarnation + ":2", createdAt: 1000, retained: [], retired: [] });
  const path = await mkdtemp(join(tmpdir(), "kayra-managed-owner-")); const artifacts = await openArtifactStore(join(path, "artifacts")); let journal = await openJournal(path); let clock = 1000; let book: unknown = null; let binding: string | undefined; let reserveCalls = 0; let settleCalls = 0; let loseReserve = false; let loseSettle = false; let authorize = true; let loseJobStart = false;
  const native = new Map<string, ServiceObservation>(); const calls: ManagedServiceAction[] = []; let routes = true;
  const observation = { status: "ready", engine: "29.9.3", api: "1.56", node: candidate.host.node, cluster: candidate.host.cluster, network: candidate.host.network.id, capacity: { cpu: candidate.host.profile.cpu_millicores, memory: candidate.host.profile.memory_bytes }, standing: { cpu: candidate.host.profile.platform_cpu_millicores, memory: candidate.host.profile.platform_memory_bytes } } as const;
  const admission: ManagedAdmissionPort = {
    reserve: (identity: ManagedAdmissionIdentity, claim: ManagedAdmissionClaim) => {
      reserveCalls++; const result = reserveManagedTransition(book, observation, claim, Number(identity.action.split(":")[1]), identity.deadline, clock); if (!result.ok) return Promise.resolve("refused"); book = result.value; binding = JSON.stringify(identity);
      return loseReserve ? Promise.reject(new Error("lost reservation acknowledgement")) : Promise.resolve("reserved");
    },
    observe: (identity) => {
      if (book === null) return Promise.resolve("absent"); const checked = parseResourceBook(book); assert.ok(checked.ok); const charge = checked.value.charges[0]; assert.ok(charge);
      if (charge.sequence < Number(identity.action.split(":")[1]) && charge.result !== "pending") return Promise.resolve("absent"); if (binding !== JSON.stringify(identity)) return Promise.resolve("foreign");
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
      const ledger = parseResourceBook(book); assert.ok(ledger.ok); assert.equal(ledger.value.charges[0]?.result, "pending"); const state = await owner.read(); assert.ok(state); const effect = action.effect === "restore" ? state.operation.recovery?.nodes.find((value) => value.name === spec.service)?.child?.attempts.at(-1) : spec.role === "retained-dependency" ? state.operation.preparation?.nodes.find((value) => value.name === spec.service)?.execution : state.operation.consumers?.nodes.find((value) => value.name === spec.service)?.execution; assert.equal(effect?.phase, "observing");
      if (!(await owner.source()).candidate.rollout.rollback_compatible) assert.ok(state.operation.compatibilityFencedAt);
      const before = native.get(action.service); assert.equal(expected?.version ?? null, before?.status === "owned" ? before.version : null); calls.push(action);
      native.set(action.service, { status: "owned", id: action.service.padEnd(25, "s"), version: before?.status === "owned" ? before.version + 1 : 1, action: action.action, effect: action.effect, taskEffect: action.effect, plan: action.plan, taskPlan: action.plan, specMatches: true, tombstone: false, retainedInputsCleared: false, containersStopped: false, containersConverged: true, replicas: 1, endpoint: "vip", update: "completed", tasks: [{ id: action.service.padEnd(25, "t"), incarnation: action.incarnation, action: action.action, effect: action.effect, plan: action.plan, desired: "running", state: "running", health: "healthy" }] }); return "acknowledged" as const;
    },
    tombstone: (action: ManagedServiceAction, expected: ServiceVersion | null) => {
      const before = native.get(action.service); assert.equal(before?.status, "owned"); assert.equal(expected?.version, before.version);
      native.set(action.service, { ...before, version: before.version + 1, action: action.action, effect: action.effect, plan: action.plan, tombstone: true, retainedInputsCleared: action.effect === "scrub", containersStopped: true, containersConverged: true, replicas: 0, endpoint: "dnsrr", tasks: [] }); return Promise.resolve("acknowledged" as const);
    },
    fence: (action: ManagedServiceAction, expected: ServiceVersion) => { const before = native.get(action.service); assert.equal(before?.status, "owned"); assert.equal(expected.version, before.version); native.set(action.service, { ...before, version: before.version + 1, action: action.action, effect: "fence" }); return Promise.resolve("acknowledged" as const); },
  };
  const nodes = new Map<string, ReturnType<typeof jobRuntime>>();
  const nodeFor = (job: JobPlan) => { const name = jobName(job.scope); let value = nodes.get(name); if (value === undefined) { value = jobRuntime(job); nodes.set(name, value); } value.now(clock); return value; };
  let foreignJobs = false; let probeOutcome: "applied" | "not-applied" | "unknown" = "unknown";
  const jobs = {
    observe: async (job: JobPlan) => { if (foreignJobs) return { status: "foreign" as const }; const value = await nodeFor(job).native.observe(job); return value.status === "owned" && value.state === "succeeded" && job.scope.purpose === "probe" ? { ...value, probe: probeOutcome } : value; },
    create: (job: JobPlan) => { const database = native.get("db"); assert.equal(database?.status, "owned"); assert.equal(database.tasks[0]?.health, "healthy"); const inputs = managedMigrationInputs(candidate, job); assert.ok(inputs.ok); return nodeFor(job).native.create(job, Object.fromEntries(Object.entries(inputs.value.environment).map(([key, value]) => [key, value.kind === "literal" ? value.value : "PRIVATE_JOB_VALUE"]))); },
    start: async (job: JobPlan, id: string, deadline?: number) => { const state = await owner.read(); assert.equal(state?.operation.preparation?.sequence?.steps[0]?.attempts.at(-1)?.execution?.phase, "start-intent"); const result = await nodeFor(job).native.start(job, id, deadline); if (migrations === "unknown" && job.scope.purpose === "migration") nodeFor(job).state("exited", 1); if (loseJobStart) throw new Error("lost migration Start acknowledgement"); return result; },
    fence: (job: JobPlan, id: string | null, deadline: number) => nodeFor(job).native.fence(job, id, deadline),
  };
  let checkMode: "pass" | "fail" | "unknown" = "pass"; const checkStarts: ContainerCheckPlan[] = []; const execs = new Map<string, { readonly code: number }>();
  const checks: ManagedChecksPort = {
    select: (action, service, task) => Promise.resolve({ status: "owned", target: { action, service: service.id, task, container: createHash("sha256").update(action.action).digest("hex") } }),
    create: (plan) => { const id = createHash("sha256").update(JSON.stringify(plan)).digest("hex"); execs.set(id, { code: 0 }); return Promise.resolve({ status: "created", id }); },
    start: (plan, id) => { checkStarts.push(plan); execs.set(id, { code: plan.target.action.effect === "restore" || checkMode !== "fail" ? 0 : 7 }); return Promise.resolve(checkMode === "unknown" ? "uncertain" : "acknowledged"); },
    observe: (_plan, id) => Promise.resolve(execs.has(id) ? { status: "owned", id, running: false, exitCode: execs.get(id)?.code ?? null } : { status: "absent" }),
  };
  const ports = { ...artifacts, now: () => clock, admission, services, checks: checked ? checks : undefined, authorize: () => Promise.resolve(authorize), jobs, readiness: { check: (action: ManagedServiceAction) => Promise.resolve({ app: action.app, incarnation: action.incarnation, service: action.service, action: action.action, plan: action.plan, checkedAt: clock, status: routes || action.effect === "restore" ? "ready" as const : "unready" as const }) } };
  let resolutionCut: "before" | "after" | null = null;
  const view = () => ({ read: journal.read, write: async (raw: Parameters<typeof journal.write>[0]) => {
    const auditing = parseManagedLifecycleStore(raw).operation.preparation?.sequence?.steps.some((step) => step.resolution !== undefined) ?? false;
    if (auditing && resolutionCut === "before") throw new Error("injected before audit write"); await journal.write(raw); if (auditing && resolutionCut === "after") throw new Error("injected lost audit acknowledgement");
  } });
  let owner = managedLifecycleOwner(view(), candidate.infrastructure.ownership, ports);
  t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  return { source, calls, nodes, artifacts, checkStarts, probeOutcome: (value: typeof probeOutcome) => { probeOutcome = value; }, checkMode: (value: typeof checkMode) => { checkMode = value; }, foreignJobs: (value: boolean) => { foreignJobs = value; }, failRoutes: () => { routes = false; }, loseJobStart: () => { loseJobStart = true; }, owner: () => owner, reserveCalls: () => reserveCalls, settleCalls: () => settleCalls, book: () => book, clock: (value: number) => { clock = value; }, loseReserve: () => { loseReserve = true; }, loseSettle: () => { loseSettle = true; }, deny: () => { authorize = false; },
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

test("an unsafe maintenance operation fences compatibility before application starts and never increments again on reopen", async (t) => {
  const lab = await fixture(t, true, true, true); await lab.owner().begin(lab.source); lab.loseJobStart();
  await assert.rejects(lab.drive(), /lost migration Start acknowledgement/); const before = await lab.owner().read(); assert.ok(before);
  assert.equal(before.compatibilityEpoch, 1); assert.equal(before.operation.compatibilityEpoch, 1); assert.ok(before.operation.compatibilityFencedAt);
  await lab.reopen(); const done = await lab.drive(); assert.equal(done.operation.phase, "complete"); assert.equal(done.compatibilityEpoch, 1); assert.equal(done.active?.epoch, 1); assert.equal(done.operation.compatibilityFencedAt, before.operation.compatibilityFencedAt);
});

for (const unsafe of [false, true]) test(`historical restore ${unsafe ? "refuses a prior data epoch even when disguised as deployment" : "accepts authenticated compatible history"}`, async (t) => {
  const lab = await fixture(t); await lab.owner().begin(lab.source); const first = await lab.drive(); assert.ok(first.active); assert.equal(first.active.epoch, 0);
  const releaseA = parseManagedRelease(JSON.parse(await lab.artifacts.read(first.active.record)));
  const candidate = parseManagedApplicationPlan({ ...lab.source.candidate, commit: "b".repeat(40), grants: { ...lab.source.candidate.grants, maintenance: unsafe }, rollout: { ...lab.source.candidate.rollout, strategy: unsafe ? "maintenance" : "rolling", rollback_compatible: !unsafe } }); assert.ok(candidate.ok);
  const references = (release: typeof releaseA) => managedReleaseBaselines(release).filter((value) => release.source.application.services[value.name]?.role === "retained-dependency").map((value) => ({ ...value, kind: "active" as const }));
  const secondSource = parseManagedLifecycleSource({ ...lab.source, candidate: candidate.value, run: randomUUID(), action: lab.source.candidate.infrastructure.ownership.incarnation + ":3", previous: releaseA, retained: references(releaseA) });
  await lab.owner().begin(secondSource); const second = await lab.drive(); assert.equal(second.operation.phase, "complete"); assert.ok(second.active); assert.equal(second.active.epoch, unsafe ? 1 : 0);
  const releaseB = parseManagedRelease(JSON.parse(await lab.artifacts.read(second.active.record))); await lab.reopen();
  const restore = parseManagedLifecycleSource({ ...lab.source, run: randomUUID(), action: lab.source.candidate.infrastructure.ownership.incarnation + ":4", previous: releaseB, retained: references(releaseB), restore: first.active.record });
  if (unsafe) {
    await assert.rejects(lab.owner().begin(restore), /compatibility fence/); await assert.rejects(lab.owner().begin({ ...restore, restore: null }), /compatibility fence/);
    assert.deepEqual(await lab.owner().read(), second); assert.equal(lab.reserveCalls(), 2);
  } else { const accepted = await lab.owner().begin(restore); assert.equal(accepted.compatibilityEpoch, 0); assert.equal(accepted.operation.phase, "admitting"); }
});

for (const cancel of [false, true]) test(`connected rolling recovery verifies and promotes A before settling previous capacity${cancel ? " after cancellation" : " after candidate failure"}`, async (t) => {
  const lab = await fixture(t); await lab.owner().begin(lab.source); const initial = await lab.drive(); assert.ok(initial.active);
  const previous = parseManagedRelease(JSON.parse(await lab.artifacts.read(initial.active.record))); const retained = managedReleaseBaselines(previous).filter((value) => previous.source.application.services[value.name]?.role === "retained-dependency").map((value) => ({ ...value, kind: "active" as const }));
  const candidate = parseManagedApplicationPlan({ ...lab.source.candidate, commit: "b".repeat(40) }); assert.ok(candidate.ok);
  const source = parseManagedLifecycleSource({ ...lab.source, candidate: candidate.value, run: randomUUID(), action: lab.source.candidate.infrastructure.ownership.incarnation + ":3", previous, retained });
  await lab.owner().begin(source); lab.failRoutes();
  for (let count = 0; count < 100; count++) { const state = await lab.owner().tick(); if (state?.operation.consumers?.nodes.some((node) => node.execution?.phase === "observing")) break; }
  const dispatched = await lab.owner().read(); assert.ok(dispatched?.operation.consumers); lab.clock(dispatched.operation.consumers.deadline);
  const failed = await lab.drive(); assert.equal(failed.operation.phase, "held"); assert.equal(failed.active?.record, initial.active.record);
  const recovering = await lab.owner().tick(); assert.equal(recovering?.operation.phase, "recovering"); const deadline = recovering.operation.recoveryDeadline; assert.ok(deadline);
  if (cancel) await lab.owner().cancel(); await lab.reopen(); const done = await lab.drive(); assert.equal(done.operation.phase, "complete"); assert.equal(done.operation.outcome, "rolled-back"); assert.equal(done.operation.settlement, "previous"); assert.equal(done.operation.recoveryDeadline, deadline); assert.equal(done.operation.recoveryVerification?.phase, "verified");
  assert.equal(done.active?.plan, initial.active.plan); assert.notEqual(done.active.record, initial.active.record); assert.equal(done.active.run, source.run); assert.equal(done.operation.plan, failed.operation.plan); assert.deepEqual(done.active, done.lastGood);
  const book = parseResourceBook(lab.book()); assert.ok(book.ok); assert.equal(book.value.charges[0]?.result, "previous"); assert.deepEqual(lab.calls.filter((action) => action.effect === "restore").map((action) => action.service).toSorted(), ["web", "worker"]);
  assert.equal(done.operation.cancelRequestedAt !== null, cancel); const restored = parseManagedRelease(JSON.parse(await lab.artifacts.read(done.active.record))); assert.equal(restored.source.kind, "recovery");
  if (!cancel) {
    const nextCandidate = parseManagedApplicationPlan({ ...lab.source.candidate, commit: "c".repeat(40) }); assert.ok(nextCandidate.ok);
    const next = parseManagedLifecycleSource({ ...source, candidate: nextCandidate.value, previous: restored, run: randomUUID(), action: source.candidate.infrastructure.ownership.incarnation + ":4", createdAt: done.active.verifiedAt, retained: managedReleaseBaselines(restored).filter((value) => restored.source.application.services[value.name]?.role === "retained-dependency").map((value) => ({ ...value, kind: "active" as const })) });
    await assert.rejects(lab.owner().begin({ ...next, previous }), /previous release/); await lab.owner().begin(next); await lab.owner().tick(); const admitted = await lab.owner().tick(); assert.equal(admitted?.operation.phase, "preparing");
  }
});

const checkedCandidate = async (t: TestContext, migrations = false, dependency: boolean | "shared" = false) => {
  const lab = await fixture(t, false, migrations, false, true); await lab.owner().begin(lab.source); const initial = await lab.drive(); assert.ok(initial.active);
  const previous = parseManagedRelease(JSON.parse(await lab.artifacts.read(initial.active.record))); const worker = lab.source.candidate.services[dependency === "shared" ? "db" : "worker"]; assert.ok(worker);
  const candidate = parseManagedApplicationPlan({ ...lab.source.candidate, commit: "b".repeat(40), services: dependency ? { ...lab.source.candidate.services, cache: { ...worker, service: "cache", nativeName: managedServiceName(worker.owner, "cache"), role: "retained-dependency" } } : lab.source.candidate.services,
    rollout: { ...lab.source.candidate.rollout, services: dependency ? { ...lab.source.candidate.rollout.services, cache: { role: "retained-dependency", overlap: "forbidden" } } : lab.source.candidate.rollout.services } }); assert.ok(candidate.ok);
  const retained = managedReleaseBaselines(previous).filter((value) => previous.source.application.services[value.name]?.role === "retained-dependency").map((value) => ({ ...value, kind: "active" as const }));
  const source = parseManagedLifecycleSource({ ...lab.source, candidate: candidate.value, previous, retained, run: randomUUID(), action: lab.source.candidate.infrastructure.ownership.incarnation + ":3" });
  await lab.owner().begin(source); return { lab, initial, source };
};

test("rollback runs the previous release's declared checks under a distinct recovery identity before promotion", async (t) => {
  const { lab, initial, source } = await checkedCandidate(t); lab.checkMode("fail"); const failed = await lab.drive(); assert.equal(failed.operation.verification?.reason, "check-failed");
  const done = await lab.drive(); assert.equal(done.operation.outcome, "rolled-back"); assert.equal(done.active?.plan, initial.active?.plan); assert.equal(lab.checkStarts.length, 3);
  const last = lab.checkStarts.at(-1); assert.ok(last); assert.equal(last.target.action.effect, "restore"); assert.notEqual(last.run, source.run); assert.equal(done.operation.recoveryVerification?.checkRun, last.run);
});

test("a possibly started unknown check cannot be bypassed by healthy services, restart or rollback compatibility", async (t) => {
  const { lab } = await checkedCandidate(t); lab.checkMode("unknown"); const failed = await lab.drive(); assert.equal(failed.operation.verification?.reason, "check-unknown");
  await lab.reopen(); lab.checkMode("pass"); assert.deepEqual(await lab.owner().tick(), failed); assert.equal(failed.operation.recoverySource, null); assert.equal(lab.calls.filter((action) => action.effect === "restore").length, 0); assert.equal(lab.checkStarts.length, 2);
  const book = parseResourceBook(lab.book()); assert.ok(book.ok); assert.equal(book.value.charges[0]?.result, "pending");
});

test("recorded migration fences cannot authorize recovery after their current native ownership is lost", async (t) => {
  const { lab } = await checkedCandidate(t, true); lab.checkMode("fail"); const failed = await lab.drive(); lab.foreignJobs(true);
  assert.deepEqual(await lab.owner().tick(), failed); assert.equal(lab.calls.filter((action) => action.effect === "restore").length, 0);
  lab.foreignJobs(false); const done = await lab.drive(); assert.equal(done.operation.outcome, "rolled-back"); assert.equal([...lab.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 2);
});

for (const shared of [false, true]) test(`rollback preserves new-only dependency retirement proof${shared ? " with a recorded shared volume" : ""} and refuses to lose it on the next deployment`, async (t) => {
  const { lab, source } = await checkedCandidate(t, false, shared ? "shared" : true); lab.checkMode("fail"); await lab.drive(); const done = await lab.drive(); assert.equal(done.operation.outcome, "rolled-back"); assert.ok(done.active);
  const retirement = done.operation.recovery?.nodes.find((node) => node.name === "cache")?.child?.barrier; assert.equal(retirement?.phase, "complete");
  const cache = source.candidate.services["cache"]; assert.ok(cache); const previous = parseManagedRelease(JSON.parse(await lab.artifacts.read(done.active.record)));
  const retained = managedReleaseBaselines(previous).filter((value) => previous.source.application.services[value.name]?.role === "retained-dependency").map((value) => ({ ...value, kind: "active" as const }));
  const next = parseManagedLifecycleSource({ ...source, candidate: previous.source.application, previous, run: randomUUID(), action: source.candidate.infrastructure.ownership.incarnation + ":4", retained, retired: [{ plan: cache, barrier: retirement }] });
  await assert.rejects(lab.owner().begin({ ...next, retired: [] }), /preserve dependencies retired/); const accepted = await lab.owner().begin(next); assert.equal(accepted.operation.phase, "admitting");
});

test("a new migration assertion cannot restart forward deployment after recovery has superseded it", async (t) => {
  const lab = await fixture(t, false, "unknown"); await lab.owner().begin(lab.source); await lab.drive(); await lab.owner().resolveMigration(resolution(lab.source.run), actor); const initial = await lab.drive(); assert.ok(initial.active);
  const previous = parseManagedRelease(JSON.parse(await lab.artifacts.read(initial.active.record))); const candidate = parseManagedApplicationPlan({ ...lab.source.candidate, commit: "b".repeat(40) }); assert.ok(candidate.ok);
  const retained = managedReleaseBaselines(previous).filter((value) => previous.source.application.services[value.name]?.role === "retained-dependency").map((value) => ({ ...value, kind: "active" as const }));
  const source = parseManagedLifecycleSource({ ...lab.source, candidate: candidate.value, previous, retained, run: randomUUID(), action: lab.source.candidate.infrastructure.ownership.incarnation + ":3" }); await lab.owner().begin(source); lab.probeOutcome("not-applied");
  assert.equal((await lab.drive()).operation.preparation?.sequence?.reason, "not-applied"); const recovery = await lab.owner().tick(); assert.equal(recovery?.operation.phase, "recovering"); await lab.owner().tick(); lab.clock(recovery.operation.recoveryDeadline ?? 0); assert.equal((await lab.owner().tick())?.operation.phase, "held");
  await assert.rejects(lab.owner().resolveMigration(resolution(source.run), actor), /superseded forward/); assert.equal([...lab.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 4);
});
