/* eslint-disable functional/no-let, functional/prefer-immutable-types -- owns test handles, clocks and acknowledgement faults */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { recoveryFixture } from "./http-recovery-fixture.ts";
import { sequenceFixture } from "./migration-sequence-fixture.ts";
import { completePorts } from "./rollout-plan-fixture.ts";
import { parseRolloutPlan } from "../../src/contracts/rollout-plan.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { rolloutExecution } from "../../src/server/deployment/rollout-execution.ts";
import { parseLifecycleEnvelope } from "../../src/server/deployment/lifecycle-envelope.ts";
import { deploymentControl } from "../../src/server/deployment/deployment-control.ts";
import { parseCompleteDeploymentReceipt } from "../../src/contracts/deployment-request.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";

const fixture = async (t: TestContext, running = true, probe: "applied" | "unknown" = "applied", failure = false) => {
  const lab = await recoveryFixture(t); const jobs = await sequenceFixture(t, undefined, { probe, afterStart: (job, runtime) => {
    if (job.scope.purpose === "migration") { if (failure) runtime.state("exited", 1); else if (running) runtime.state("running"); }
  } }); jobs.now(lab.ports.now());
  const ports = { ...lab.ports, ...lab.artifacts, jobs: jobs.ports.native, materialize: () => Promise.resolve({ TOKEN: "private-value", RELEASE: "A" }) };
  const original = completePorts(lab.ports, !failure); const plans = { ...original, preview: async (...args: Readonly<Parameters<typeof original.preview>>) => {
    const plan = await original.preview(...args); const first = plan.rollout.migrations[0]; assert.ok(first);
    const parsed = parseRolloutPlan({ ...plan, rollout: { ...plan.rollout, migrations: [first, { ...first, id: "seed" }] } }); assert.ok(parsed.ok); return parsed.value;
  } };
  await lab.index.prepareBuild("shop", "b".repeat(40), lab.builds); const parent = await lab.index.prepareRollout("shop", randomUUID(), "b".repeat(40), plans);
  const owner = rolloutExecution(lab.index, ports);
  const drive = async (predicate: (operation: NonNullable<Awaited<ReturnType<typeof lab.index.rolloutOperation>>>) => boolean) => {
    for (let count = 0; count < 60; count++) { await owner.tick("shop", parent.preparation.run); const state = await lab.index.rolloutOperation("shop", parent.preparation.run); assert.ok(state); if (predicate(state)) return state; }
    throw new Error("rollout did not reach cancellation checkpoint");
  };
  const stop = async () => {
    for (let count = 0; count < 60; count++) { const phase = await owner.tick("shop", parent.preparation.run); if (phase === "cancelled" || phase === "held") return phase; }
    throw new Error("rollout cancellation did not settle");
  };
  return { ...lab, jobs, ports, parent, owner, drive, stop };
};

test("cancelling after sequence intent settles a known empty prefix without creating a migration or HTTP child", async (t) => {
  const lab = await fixture(t); await lab.drive((state) => state.preparation.sequence !== null && state.preparation.sequence.steps.length === 0);
  const cancelled = await lab.index.cancelRolloutPreparation("shop", lab.parent.preparation.run, lab.ports);
  assert.equal(cancelled.completion?.kind, "cancelled-preparation"); assert.equal(cancelled.completion.outcome, "cancelled");
  assert.equal(lab.jobs.nodes.size, 0); assert.equal(await lab.index.httpOperation("shop", lab.parent.preparation.run), undefined);
  const status = await lab.index.deploymentStatus("shop"); assert.equal(status.preparation?.phase, "cancelled"); assert.equal(status.preparation.cancelRequestedAt, lab.ports.now());
  assert.equal(status.verifiedActive?.plan, lab.initial.plan); assert.equal(status.desired?.plan, lab.initial.plan); assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "previous");
  assert.equal(lab.writes(), 1);
});

test("restart after cancellation intent cannot Start the already created migration container", async (t) => {
  const lab = await fixture(t); await lab.drive((state) => state.preparation.sequence?.steps[0]?.attempts[0]?.execution?.phase === "create-intent" && [...lab.jobs.nodes.values()].some((node) => node.raw() !== undefined));
  const requested = await lab.index.cancelRolloutPreparation("shop", lab.parent.preparation.run, lab.ports); assert.equal(requested.completion, undefined); await lab.index.close(); lab.now(5000); lab.jobs.now(5000);
  const index = await openLifecycleAppIndex(lab.path); t.after(() => index.close()); const owner = rolloutExecution(index, lab.ports);
  for (let count = 0; count < 30; count++) if (await owner.tick("shop", lab.parent.preparation.run) === "cancelled") break;
  const state = await index.rolloutOperation("shop", lab.parent.preparation.run); assert.equal(state?.completion?.outcome, "cancelled");
  assert.equal(state.preparation.cancelRequestedAt, requested.preparation.cancelRequestedAt); assert.equal(state.preparation.deadline, lab.parent.preparation.deadline);
  assert.equal([...lab.jobs.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 0);
  assert.equal(await index.httpOperation("shop", lab.parent.preparation.run), undefined);
});

test("cancelling a running migration fences it and runs only its declared probe, preserving the previous release", async (t) => {
  const lab = await fixture(t); await lab.drive((state) => state.preparation.sequence?.steps[0]?.attempts[0]?.execution?.phase === "observing");
  await lab.index.cancelRolloutPreparation("shop", lab.parent.preparation.run, lab.ports); assert.equal(await lab.stop(), "cancelled");
  const state = await lab.index.rolloutOperation("shop", lab.parent.preparation.run); assert.equal(state?.completion?.kind, "cancelled-preparation");
  assert.equal(state.preparation.sequence?.steps.length, 1); assert.equal(state.preparation.sequence.steps[0]?.attempts.length, 2);
  assert.equal([...lab.jobs.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 2);
  assert.equal([...lab.jobs.nodes.values()].some((node) => node.plan.scope.step === "seed"), false);
  assert.equal((await lab.index.deploymentStatus("shop")).verifiedActive?.plan, lab.initial.plan); assert.equal(lab.writes(), 1);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "previous");
});

test("an unknown probe keeps cancellation held and capacity charged for an audited decision", async (t) => {
  const lab = await fixture(t, true, "unknown"); await lab.drive((state) => state.preparation.sequence?.steps[0]?.attempts[0]?.execution?.phase === "observing");
  await lab.index.cancelRolloutPreparation("shop", lab.parent.preparation.run, lab.ports); assert.equal(await lab.stop(), "held");
  const status = await lab.index.deploymentStatus("shop"); assert.equal(status.preparation?.phase, "held"); assert.equal(status.preparation.cancelRequestedAt, lab.ports.now());
  assert.equal(status.requiredAction, "inspect-and-resolve"); assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
  assert.equal((await lab.index.rolloutOperation("shop", lab.parent.preparation.run))?.completion, undefined);
});

test("cancellation after migration readiness retains the original HTTP deadline without creating a handoff", async (t) => {
  const lab = await fixture(t, false); const ready = await lab.drive((state) => state.preparation.phase === "ready"); assert.ok(ready.preparation.httpDeadline);
  const cancelled = await lab.index.cancelRolloutPreparation("shop", lab.parent.preparation.run, lab.ports);
  assert.equal(cancelled.completion?.outcome, "cancelled"); assert.equal(cancelled.preparation.httpDeadline, ready.preparation.httpDeadline);
  assert.equal((await lab.index.deploymentStatus("shop")).preparation?.httpDeadline, ready.preparation.httpDeadline);
  await assert.rejects(lab.index.handoffRollout("shop", lab.parent.preparation.run, lab.ports), /ownership|ready/);
  assert.equal(await lab.index.httpOperation("shop", lab.parent.preparation.run), undefined); assert.equal(lab.writes(), 1);
});

test("restart settles a cancelled prefix whose synchronized completion acknowledgement was lost", async (t) => {
  const lab = await fixture(t); await lab.drive((state) => state.preparation.sequence !== null && state.preparation.sequence.steps.length === 0); await lab.index.close();
  let lose = true;
  const journals: typeof openJournal = async (path, mode) => {
    const journal = await openJournal(path, mode); let poisoned = false;
    return { ...journal, read: () => poisoned ? Promise.reject(new Error("uncertain cancellation completion")) : journal.read(), write: async (value) => {
      if (poisoned) throw new Error("uncertain cancellation completion"); await journal.write(value);
      const envelope = parseLifecycleEnvelope(value);
      if (lose && envelope.ok && envelope.value.rollout?.completion?.kind === "cancelled-preparation") {
        lose = false; poisoned = true; throw new Error("lost cancellation completion acknowledgement");
      }
    } };
  };
  const interrupted = await openLifecycleAppIndex(lab.path, undefined, journals);
  await assert.rejects(interrupted.cancelRolloutPreparation("shop", lab.parent.preparation.run, lab.ports), /lost cancellation completion/); await interrupted.close();
  const index = await openLifecycleAppIndex(lab.path); t.after(() => index.close());
  assert.equal((await index.rolloutOperation("shop", lab.parent.preparation.run))?.completion?.outcome, "cancelled");
  assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "pending");
  assert.equal(await rolloutExecution(index, lab.ports).tick("shop", lab.parent.preparation.run), "cancelled");
  assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "previous"); assert.equal(lab.jobs.nodes.size, 0);
});

test("an audited outcome resolves held cancellation without continuing deployment or changing the original receipt", async (t) => {
  const lab = await fixture(t, true, "unknown"); await lab.drive((state) => state.preparation.sequence?.steps[0]?.attempts[0]?.execution?.phase === "observing");
  await lab.index.cancelRolloutPreparation("shop", lab.parent.preparation.run, lab.ports); assert.equal(await lab.stop(), "held");
  const request = { app: "shop", run: lab.parent.preparation.run, step: "schema", outcome: "not-applied" as const, reason: "Application ledger confirms cancellation left this migration unapplied" };
  const actor = { kind: "operator-control" as const, identity: "test-operator" }; const recovery = { ...lab.artifacts, now: lab.ports.now, native: lab.jobs.ports.native };
  const receipt = await lab.index.resolveMigration("shop", request, actor, recovery); assert.equal(receipt.disposition, "cancelled");
  assert.equal((await lab.index.rolloutOperation("shop", request.run))?.completion?.outcome, "cancelled");
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "previous"); assert.equal((await lab.index.deploymentStatus("shop")).preparation?.phase, "cancelled");
  assert.equal((await lab.index.migrationAudit("shop", request.run, "schema"))?.cancelRequestedAt, lab.ports.now());
  assert.deepEqual(await lab.index.resolveMigration("shop", request, actor, recovery), receipt);
  assert.equal([...lab.jobs.nodes.values()].some((node) => node.plan.scope.step === "seed"), false); assert.equal(lab.writes(), 1);
});

test("normal cancellation control reports complete-plan identity and keeps status scoped", async (t) => {
  const lab = await fixture(t); await lab.drive((state) => state.preparation.sequence?.steps[0]?.attempts[0]?.execution?.phase === "observing");
  const control = deploymentControl({ index: lab.index, now: lab.ports.now, canAccess: () => Promise.resolve(true), enabled: () => Promise.resolve(false) });
  const input = { app: "shop", request: lab.parent.preparation.run };
  assert.equal(await control("/deployment/cancel", { ...input, deadline: 999999999 }), undefined);
  const requested = parseCompleteDeploymentReceipt(await control("/deployment/cancel", input)); assert.ok(requested.ok);
  assert.equal(requested.value.version, 2); assert.equal(requested.value.plan, lab.parent.preparation.plan); assert.equal(requested.value.phase, "cancelling");
  assert.equal((await lab.index.deploymentStatus("shop")).preparation?.phase, "cancelling");
  assert.equal(await lab.stop(), "cancelled"); const final = parseCompleteDeploymentReceipt(await control("/deployment/cancel", input)); assert.ok(final.ok);
  assert.equal(final.value.phase, "cancelled"); assert.equal(final.value.cancelRequestedAt, requested.value.cancelRequestedAt);
  assert.equal(final.value.deadline, requested.value.deadline);
});

test("complete-plan HTTP cancellation atomically keeps its parent intent and reconstructs restoration", async (t) => {
  const lab = await fixture(t, false);
  for (let count = 0; count < 60; count++) { await lab.owner.tick("shop", lab.parent.preparation.run); if (lab.writes() >= 2) break; }
  assert.equal(lab.writes(), 2);
  const cancelled = await lab.index.cancelManagedRollout("shop", lab.parent.preparation.run, lab.ports);
  assert.equal(cancelled.http?.phase, "recovering"); assert.equal(cancelled.operation.preparation.cancelRequestedAt, lab.ports.now());
  await lab.index.close(); const index = await openLifecycleAppIndex(lab.path); t.after(() => index.close()); const owner = rolloutExecution(index, lab.ports);
  for (let count = 0; count < 40; count++) if (await owner.tick("shop", lab.parent.preparation.run) === "cancelled") break;
  assert.equal((await index.httpOperation("shop", lab.parent.preparation.run))?.phase, "cancelled");
  assert.equal((await index.httpOperation("shop", lab.parent.preparation.run))?.recovery?.kind, "compensated");
  assert.equal((await index.deploymentStatus("shop")).verifiedActive?.plan, lab.initial.plan); assert.equal(lab.writes(), 3);
  await owner.tick("shop", lab.parent.preparation.run);
  assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "previous");
});

test("a cancelled uncreated retry cannot hide an earlier failed effect and needs an audited outcome", async (t) => {
  const lab = await fixture(t, true, "unknown", true);
  await lab.drive((state) => state.preparation.sequence?.steps[0]?.attempts.length === 2 && state.preparation.sequence.steps[0].attempts[1]?.execution === null);
  await lab.index.cancelRolloutPreparation("shop", lab.parent.preparation.run, lab.ports); assert.equal(await lab.stop(), "held");
  const request = { app: "shop", run: lab.parent.preparation.run, step: "schema", outcome: "not-applied" as const, reason: "Application ledger proves the failed attempt left the step unapplied" };
  const actor = { kind: "operator-control" as const, identity: "test-operator" };
  await assert.rejects(lab.index.resolveMigration("shop", request, actor, { ...lab.artifacts, now: lab.ports.now, native: { observe: (job) => job.scope.attempt === 2 ? Promise.resolve({ status: "foreign" as const }) : lab.jobs.ports.native.observe(job) } }), /unexpected runtime state/);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
  const result = await lab.index.resolveMigration("shop", request, actor, { ...lab.artifacts, now: lab.ports.now, native: lab.jobs.ports.native }); assert.equal(result.disposition, "cancelled");
  assert.equal([...lab.jobs.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 1);
  assert.equal((await lab.index.deploymentStatus("shop")).verifiedActive?.plan, lab.initial.plan);
});
