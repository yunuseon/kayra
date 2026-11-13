/* eslint-disable functional/no-let, functional/prefer-immutable-types -- owns cleanup contexts, clock faults and journal acknowledgement loss */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { recoveryFixture } from "./http-recovery-fixture.ts";
import { sequenceFixture } from "./migration-sequence-fixture.ts";
import { completePorts } from "./rollout-plan-fixture.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { deploymentControl } from "../../src/server/deployment/deployment-control.ts";
import { rolloutExecution } from "../../src/server/deployment/rollout-execution.ts";

const actor = { kind: "operator-control" as const, identity: "lab-operator" };
const fixture = async (t: TestContext) => {
  const lab = await recoveryFixture(t); const jobs = await sequenceFixture(t, undefined, { probe: "unknown", afterStart: (job, runtime) => {
    if (job.scope.purpose === "migration") runtime.state("exited", 1);
  } }); jobs.now(lab.ports.now());
  const ports = { ...lab.ports, ...lab.artifacts, jobs: jobs.ports.native, materialize: () => Promise.resolve({ TOKEN: "private-value", RELEASE: "A" }) };
  await lab.index.prepareBuild("shop", "b".repeat(40), lab.builds);
  const parent = await lab.index.prepareRollout("shop", randomUUID(), "b".repeat(40), completePorts(lab.ports, true));
  const owner = rolloutExecution(lab.index, ports);
  for (let count = 0; count < 100; count++) if (await owner.tick("shop", parent.preparation.run) === "held") break;
  assert.equal((await lab.index.rolloutOperation("shop", parent.preparation.run))?.preparation.phase, "held");
  const request = { app: "shop", run: parent.preparation.run, step: "schema", outcome: "applied" as const, reason: "Operator verified the application migration ledger" };
  const resolution = { ...lab.artifacts, now: ports.now, native: { observe: jobs.ports.native.observe } };
  return { ...lab, jobs, parent, ports, owner, request, resolution };
};

test("the parent atomically records an operator assertion and resumes without repeating the unsafe migration", async (t) => {
  const lab = await fixture(t); const receipt = await lab.index.resolveMigration("shop", lab.request, actor, lab.resolution);
  assert.equal(receipt.disposition, "continue"); const audit = await lab.index.migrationAudit("shop", lab.request.run, "schema");
  assert.equal(audit?.id, receipt.resolution); assert.deepEqual(audit.actor, actor); assert.equal(audit.reason, lab.request.reason);
  assert.equal((await lab.index.rolloutOperation("shop", lab.request.run))?.preparation.phase, "migrating");
  for (let count = 0; count < 20; count++) if (await lab.owner.tick("shop", lab.request.run) === "succeeded") break;
  assert.equal((await lab.index.deploymentStatus("shop")).verifiedActive?.plan, lab.parent.preparation.plan);
  assert.equal([...lab.jobs.nodes.values()].reduce((sum, job) => sum + job.executions(), 0), 2); assert.equal(lab.writes(), 2);
  assert.deepEqual(await lab.index.resolveMigration("shop", lab.request, actor, { ...lab.resolution, native: { observe: () => { throw new Error("replayed audit must not inspect runtime again"); } } }), receipt);
});

test("a not-applied operator resolution ends the failed candidate and restores only its previous resource charge", async (t) => {
  const lab = await fixture(t); const receipt = await lab.index.resolveMigration("shop", { ...lab.request, outcome: "not-applied" }, actor, lab.resolution);
  assert.equal(receipt.disposition, "failed"); assert.equal(receipt.outcome, "not-applied");
  const operation = await lab.index.rolloutOperation("shop", lab.request.run); assert.equal(operation?.completion?.kind, "migration-resolved");
  assert.equal(operation.completion.previous, lab.initial.plan); assert.equal(operation.preparation.deadline, lab.parent.preparation.deadline);
  const status = await lab.index.deploymentStatus("shop"); assert.equal(status.preparation?.phase, "failed"); assert.equal(status.preparation.reason, "migration");
  assert.equal(status.preparation.resolution?.id, receipt.resolution); assert.equal(status.preparation.step, "schema");
  assert.equal(status.verifiedActive?.plan, lab.initial.plan); assert.equal(status.desired?.plan, lab.initial.plan); assert.equal(status.requested?.plan, lab.parent.preparation.plan);
  assert.equal(status.requiredAction, "none"); assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "previous");
  assert.deepEqual(await lab.index.pendingRolloutOperations(), []); assert.equal(lab.writes(), 1);
  for (const field of ["actor", "reason-text", lab.request.reason, "environment", "attempts"]) assert.equal(JSON.stringify(status).includes(field), false);
});

test("a late applied assertion records the data outcome without a new deadline or target promotion", async (t) => {
  const lab = await fixture(t); const now = lab.parent.preparation.migrationDeadline + 1;
  const receipt = await lab.index.resolveMigration("shop", lab.request, actor, { ...lab.resolution, now: () => now });
  assert.equal(receipt.disposition, "failed"); assert.equal(receipt.outcome, "applied"); assert.equal(receipt.recordedAt, now);
  const operation = await lab.index.rolloutOperation("shop", lab.request.run); assert.equal(operation?.preparation.deadline, lab.parent.preparation.deadline);
  assert.equal(operation.preparation.sequence?.steps[0]?.appliedAt, null); assert.equal(operation.completion?.reason, "deadline");
  assert.equal((await lab.index.deploymentStatus("shop")).verifiedActive?.plan, lab.initial.plan);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "previous"); assert.equal(lab.writes(), 1);
});

test("an acknowledged audit write with a lost reply reconstructs failure and conservative capacity on restart", async (t) => {
  const lab = await fixture(t); await lab.index.close(); let lose = true;
  const journals: typeof openJournal = async (path, mode) => {
    const journal = await openJournal(path, mode); let poisoned = false;
    return { ...journal, read: () => poisoned ? Promise.reject(new Error("uncertain audit write")) : journal.read(), write: async (value) => {
      if (poisoned) throw new Error("uncertain audit write"); await journal.write(value);
      const parsed = typeof value === "object" && value !== null && !Array.isArray(value) && "rollout" in value;
      if (lose && parsed) { lose = false; poisoned = true; throw new Error("lost audit acknowledgement"); }
    } };
  };
  const interrupted = await openLifecycleAppIndex(lab.path, undefined, journals);
  await assert.rejects(interrupted.resolveMigration("shop", { ...lab.request, outcome: "not-applied" }, actor, lab.resolution), /lost audit acknowledgement/); await interrupted.close();
  const index = await openLifecycleAppIndex(lab.path); t.after(() => index.close());
  assert.equal((await index.migrationAudit("shop", lab.request.run, "schema"))?.outcome, "not-applied");
  assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "pending"); assert.deepEqual(await index.pendingRolloutOperations(), [{ app: "shop", request: lab.request.run }]);
  assert.equal(await rolloutExecution(index, lab.ports).tick("shop", lab.request.run), "failed");
  assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "previous"); assert.deepEqual(await index.pendingRolloutOperations(), []); assert.equal(lab.writes(), 1);
});

test("privileged control scopes resolution and audit, and supplies the actor independently of request fields", async (t) => {
  const lab = await fixture(t);
  const control = deploymentControl({ index: lab.index, now: lab.ports.now, canAccess: () => Promise.resolve(true), enabled: () => Promise.resolve(false), recovery: { actor, ports: lab.resolution } });
  const query = { app: lab.request.app, run: lab.request.run, step: lab.request.step };
  assert.deepEqual(await control("/deployment/migration-audit", query), { version: 1, ...query, audit: null });
  assert.equal(await control("/deployment/migration-resolve", { ...lab.request, actor: { identity: "forged" } }), undefined);
  assert.equal(await control("/deployment/migration-resolve", { ...lab.request, deadline: 9999999 }), undefined);
  const denied = deploymentControl({ index: lab.index, now: lab.ports.now, canAccess: () => Promise.resolve(false), enabled: () => Promise.resolve(true), recovery: { actor, ports: lab.resolution } });
  await assert.rejects(denied("/deployment/migration-resolve", lab.request), /outside deployment scope/);
  await assert.rejects(denied("/deployment/migration-audit", query), /outside deployment scope/);
  assert.equal(await lab.index.migrationAudit("shop", lab.request.run, "schema"), undefined);
  const result = await control("/deployment/migration-resolve", lab.request);
  assert.deepEqual(await control("/deployment/migration-resolve", lab.request), result);
  assert.deepEqual(await control("/deployment/migration-audit", query), { version: 1, ...query, audit: await lab.index.migrationAudit("shop", lab.request.run, "schema") });
  await assert.rejects(control("/deployment/migration-resolve", { ...lab.request, outcome: "not-applied" }), /already resolved differently/);
});
