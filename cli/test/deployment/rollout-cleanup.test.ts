/* eslint-disable functional/no-let, functional/prefer-immutable-types -- test contexts and injected runtime own mutable cleanup callbacks */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { jobName } from "../../src/contracts/one-shot-job.ts";
import { oneShotCleanup } from "../../src/server/runtime/one-shot-job.ts";
import { rolloutExecution } from "../../src/server/deployment/rollout-execution.ts";
import { deploymentControl } from "../../src/server/deployment/deployment-control.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { recoveryFixture } from "./http-recovery-fixture.ts";
import { sequenceFixture } from "./migration-sequence-fixture.ts";
import { completePorts } from "./rollout-plan-fixture.ts";

const actor = { kind: "operator-control" as const, identity: "test-operator" };
const fixture = async (t: TestContext, probe: "unknown" | "applied" = "unknown") => {
  const lab = await recoveryFixture(t); const jobs = await sequenceFixture(t, undefined, { probe, afterStart: (job, runtime) => { if (job.scope.purpose === "migration") runtime.state("running"); } }); jobs.now(lab.ports.now());
  const cleanup = { observe: jobs.ports.native.observe, fence: (...args: Readonly<Parameters<ReturnType<typeof oneShotCleanup>["fence"]>>) => {
    const node = jobs.nodes.get(jobName(args[0].scope)); if (node === undefined) throw new Error("missing job fixture");
    return oneShotCleanup(node.api, lab.ports.now).fence(...args);
  } };
  const ports = { ...lab.ports, ...lab.artifacts, jobs: { ...jobs.ports.native, fence: (...args: Readonly<Parameters<typeof jobs.ports.native.fence>>) => args[0].scope.purpose === "migration" ? Promise.resolve("uncertain" as const) : jobs.ports.native.fence(...args) }, cleanup,
    materialize: () => Promise.resolve({ TOKEN: "private-value", RELEASE: "A" }) };
  await lab.index.prepareBuild("shop", "b".repeat(40), lab.builds);
  const parent = await lab.index.prepareRollout("shop", randomUUID(), "b".repeat(40), completePorts(lab.ports, true));
  const owner = rolloutExecution(lab.index, ports);
  for (let count = 0; count < 40; count++) {
    await owner.tick("shop", parent.preparation.run);
    const state = await lab.index.rolloutOperation("shop", parent.preparation.run); const execution = state?.preparation.sequence?.steps[0]?.attempts[0]?.execution;
    if (execution?.phase === "observing") { lab.now((execution.executionDeadline ?? execution.deadline) + 1); jobs.now(lab.ports.now()); }
    if (execution?.phase === "fencing" && execution.fenceDeadline !== null) { lab.now(execution.fenceDeadline + 1); jobs.now(lab.ports.now()); }
    if (state?.preparation.phase === "held") break;
  }
  const held = await lab.index.rolloutOperation("shop", parent.preparation.run); assert.equal(held?.preparation.phase, "held");
  assert.equal(held.preparation.sequence?.steps[0]?.attempts[0]?.execution?.phase, "held");
  const statement = { app: "shop", run: parent.preparation.run, step: "schema", purpose: "migration" as const, attempt: 1, action: randomUUID(), reason: "Stop held migration before inspecting application ledger" };
  const recovery = { ...lab.artifacts, now: lab.ports.now, native: jobs.ports.native };
  return { ...lab, jobs, ports, owner, parent, statement, recovery, before: JSON.stringify(held.preparation.sequence.steps[0].attempts[0].execution) };
};

test("an audited cleanup stays attached to its held attempt and never rewrites execution evidence", async (t) => {
  const lab = await fixture(t); const receipt = await lab.index.requestMigrationCleanup("shop", lab.statement, actor, lab.recovery);
  assert.equal(receipt.phase, "fencing"); assert.equal(receipt.deadline, lab.ports.now() + 30000);
  assert.deepEqual(await lab.index.pendingRolloutOperations(), [{ app: "shop", request: lab.statement.run }]);
  assert.deepEqual(await lab.index.requestMigrationCleanup("shop", lab.statement, actor, lab.recovery), receipt);
  assert.equal(await lab.owner.tick("shop", lab.statement.run), "cleaning-up"); assert.equal(await lab.owner.tick("shop", lab.statement.run), "migrating");
  for (let count = 0; count < 30; count++) if (await lab.owner.tick("shop", lab.statement.run) === "held") break;
  const audit = await lab.index.migrationCleanupAudit("shop", lab.statement.run, "schema"); assert.equal(audit[0]?.records[0]?.state.phase, "complete");
  assert.deepEqual(audit[0].records[0].actor, actor); assert.equal(audit[0].records[0].reason, lab.statement.reason);
  const operation = await lab.index.rolloutOperation("shop", lab.statement.run); assert.equal(operation?.preparation.deadline, lab.parent.preparation.deadline);
  assert.equal(JSON.stringify(operation.preparation.sequence?.steps[0]?.attempts[0]?.execution), lab.before);
  assert.equal([...lab.jobs.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 2);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending"); assert.deepEqual(await lab.index.pendingRolloutOperations(), []);
  const result = await lab.index.resolveMigration("shop", { app: "shop", run: lab.statement.run, step: "schema", outcome: "not-applied", reason: "Application ledger proves the migration was not applied" }, actor, lab.recovery);
  assert.equal(result.disposition, "failed"); assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "previous");
  assert.equal((await lab.index.deploymentStatus("shop")).verifiedActive?.plan, lab.initial.plan);
});

test("cleanup admission survives restart and an expired action needs a new explicit audited identity", async (t) => {
  const lab = await fixture(t); const first = await lab.index.requestMigrationCleanup("shop", lab.statement, actor, lab.recovery); await lab.index.close();
  lab.now(first.deadline); lab.jobs.now(first.deadline);
  const index = await openLifecycleAppIndex(lab.path); t.after(() => index.close()); const owner = rolloutExecution(index, lab.ports);
  assert.equal(await owner.tick("shop", lab.statement.run), "held"); assert.equal((await index.migrationCleanupAudit("shop", lab.statement.run, "schema"))[0]?.records[0]?.state.phase, "held");
  const replay = await index.requestMigrationCleanup("shop", lab.statement, actor, lab.recovery); assert.equal(replay.deadline, first.deadline); assert.equal(replay.phase, "held");
  const second = await index.requestMigrationCleanup("shop", { ...lab.statement, action: randomUUID(), reason: "Renew explicit cleanup after investigating the expired attempt" }, actor, lab.recovery);
  assert.equal(second.deadline, first.deadline + 30000); assert.notEqual(second.action, first.action);
  await owner.tick("shop", lab.statement.run); await owner.tick("shop", lab.statement.run);
  const records = (await index.migrationCleanupAudit("shop", lab.statement.run, "schema"))[0]?.records; assert.equal(records?.length, 2); assert.equal(records[0]?.state.phase, "held"); assert.equal(records[1]?.state.phase, "complete");
  assert.equal((await index.rolloutOperation("shop", lab.statement.run))?.preparation.deadline, lab.parent.preparation.deadline);
});

test("normal control authenticates cleanup requests and publishes the separate private audit", async (t) => {
  const lab = await fixture(t); const control = deploymentControl({ index: lab.index, canAccess: () => Promise.resolve(true), enabled: () => Promise.resolve(false), now: lab.ports.now, recovery: { actor, ports: lab.recovery } });
  assert.equal(await control("/deployment/migration-cleanup", { ...lab.statement, deadline: 999999999 }), undefined);
  assert.equal(await control("/deployment/migration-cleanup", { ...lab.statement, actor: "forged" }), undefined);
  const receipt = await control("/deployment/migration-cleanup", lab.statement); assert.ok(receipt);
  await assert.rejects(control("/deployment/migration-cleanup", { ...lab.statement, reason: "Different decision" }), /audit already differs/);
  const report = await control("/deployment/migration-cleanup-audit", { app: "shop", run: lab.statement.run, step: "schema" });
  assert.deepEqual(report, { version: 1, app: "shop", run: lab.statement.run, step: "schema", cleanups: await lab.index.migrationCleanupAudit("shop", lab.statement.run, "schema") });
});

test("completed cleanup resumes the declared status probe before any operator outcome assertion", async (t) => {
  const lab = await fixture(t, "applied"); await lab.index.requestMigrationCleanup("shop", lab.statement, actor, lab.recovery);
  for (let count = 0; count < 40; count++) if (await lab.owner.tick("shop", lab.statement.run) === "succeeded") break;
  assert.equal((await lab.index.deploymentStatus("shop")).verifiedActive?.plan, lab.parent.preparation.plan);
  assert.equal(await lab.index.migrationAudit("shop", lab.statement.run, "schema"), undefined);
  const operation = await lab.index.rolloutOperation("shop", lab.statement.run);
  assert.equal(JSON.stringify(operation?.preparation.sequence?.steps[0]?.attempts[0]?.execution), lab.before);
  assert.equal([...lab.jobs.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 2);
});

test("cleanup completed after the migration deadline cannot resume probes or extend deployment authority", async (t) => {
  const lab = await fixture(t); lab.now(lab.parent.preparation.migrationDeadline + 1); lab.jobs.now(lab.ports.now());
  await lab.index.requestMigrationCleanup("shop", lab.statement, actor, lab.recovery);
  assert.equal(await lab.owner.tick("shop", lab.statement.run), "cleaning-up"); assert.equal(await lab.owner.tick("shop", lab.statement.run), "held");
  const operation = await lab.index.rolloutOperation("shop", lab.statement.run);
  assert.equal(operation?.preparation.deadline, lab.parent.preparation.deadline); assert.equal(operation.preparation.sequence?.steps[0]?.attempts.length, 1);
  assert.equal((await lab.index.deploymentStatus("shop")).verifiedActive?.plan, lab.initial.plan);
  assert.equal([...lab.jobs.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 1);
});
