/* eslint-disable functional/no-let, functional/prefer-immutable-types -- owns test contexts and failure injection */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { recoveryFixture } from "./http-recovery-fixture.ts";
import { sequenceFixture } from "./migration-sequence-fixture.ts";
import { completePorts } from "./rollout-plan-fixture.ts";
import { rolloutExecution } from "../../src/server/deployment/rollout-execution.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { reconcileRolloutWork } from "../../src/server/deployment/rollout-work.ts";

const fixture = async (t: TestContext, unsafe = false) => {
  const lab = await recoveryFixture(t); const jobs = await sequenceFixture(t, undefined, unsafe ? { probe: "unknown", afterStart: (job, runtime) => {
    if (job.scope.purpose === "migration") runtime.state("exited", 1);
  } } : {}); jobs.now(lab.ports.now());
  const planPorts = completePorts(lab.ports, unsafe);
  await lab.index.prepareBuild("shop", "b".repeat(40), lab.builds);
  const parent = await lab.index.prepareRollout("shop", randomUUID(), "b".repeat(40), planPorts);
  const ports = { ...lab.ports, ...lab.artifacts, jobs: jobs.ports.native, materialize: () => Promise.resolve({ RELEASE: "A", TOKEN: "private-value" }) };
  const drive = async (owner: ReturnType<typeof rolloutExecution>) => {
    for (let count = 0; count < 100; count++) { const phase = await owner.tick("shop", parent.preparation.run); if (phase === "succeeded" || phase === "held" || phase === "failed") return phase; }
    throw new Error("complete rollout did not converge");
  };
  return { ...lab, jobs, parent, ports, drive };
};

test("one application owner drives admitted migrations, HTTP convergence and complete-plan promotion", async (t) => {
  const lab = await fixture(t); const owner = rolloutExecution(lab.index, lab.ports);
  const prepared = await lab.index.deploymentStatus("shop"); assert.equal(prepared.requested?.plan, lab.parent.preparation.plan);
  assert.equal(prepared.preparation?.phase, "prepared"); assert.equal(prepared.operation, null); assert.equal(prepared.verifiedActive?.plan, lab.initial.plan);
  assert.deepEqual(await lab.index.pendingRolloutOperations(), [{ app: "shop", request: lab.parent.preparation.run }]);
  assert.equal(await owner.tick("shop", lab.parent.preparation.run), "admitted"); assert.equal(lab.jobs.nodes.size, 0);
  assert.equal(await lab.drive(owner), "succeeded");
  const status = await lab.index.deploymentStatus("shop"); assert.equal(status.verifiedActive?.plan, lab.parent.preparation.plan);
  assert.equal(lab.writes(), 2); assert.equal([...lab.jobs.nodes.values()].reduce((sum, job) => sum + job.executions(), 0), 1);
  assert.equal(await owner.tick("shop", lab.parent.preparation.run), "succeeded"); assert.equal(lab.writes(), 2);
  assert.deepEqual(await lab.index.pendingRolloutOperations(), []);
});

test("concurrent ticks share the same in-flight app phase and never duplicate migration Start", async (t) => {
  const lab = await fixture(t); const owner = rolloutExecution(lab.index, lab.ports);
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => owner.tick("shop", lab.parent.preparation.run))), Array.from({ length: 20 }, () => "admitted"));
  assert.equal(await lab.drive(owner), "succeeded");
  assert.equal([...lab.jobs.nodes.values()].reduce((sum, job) => sum + job.executions(), 0), 1); assert.equal(lab.writes(), 2);
});

test("restart after HTTP acknowledgement preserves completed migrations and seals the same complete release", async (t) => {
  const lab = await fixture(t); let lose = true;
  const owner = rolloutExecution(lab.index, { ...lab.ports, native: { ...lab.ports.native,
    apply: async (...args: Readonly<Parameters<typeof lab.ports.native.apply>>) => {
      const result = await lab.ports.native.apply(...args); if (lose) { lose = false; throw new Error("death after HTTP acknowledgement"); } return result;
    } } });
  await assert.rejects(lab.drive(owner), /death after HTTP acknowledgement/);
  const before = await lab.index.httpOperation("shop", lab.parent.preparation.run); assert.equal(before?.phase, "applying");
  await lab.index.close(); const reopened = await openLifecycleAppIndex(lab.path); t.after(() => reopened.close());
  assert.equal(await lab.drive(rolloutExecution(reopened, lab.ports)), "succeeded");
  assert.equal((await reopened.httpOperation("shop", lab.parent.preparation.run))?.deadline, before.deadline);
  assert.equal([...lab.jobs.nodes.values()].reduce((sum, job) => sum + job.executions(), 0), 1); assert.equal(lab.writes(), 2);
});

test("an unresolved migration holds the parent without creating any HTTP candidate", async (t) => {
  const lab = await fixture(t, true); const owner = rolloutExecution(lab.index, lab.ports);
  assert.equal(await lab.drive(owner), "held"); assert.equal(await lab.index.httpOperation("shop", lab.parent.preparation.run), undefined);
  const status = await lab.index.deploymentStatus("shop"); assert.equal(status.requiredAction, "inspect-and-resolve"); assert.equal(status.preparation?.phase, "held");
  assert.equal(status.preparation.step, "schema"); assert.equal(status.operation, null); assert.equal(status.requested?.plan, lab.parent.preparation.plan);
  assert.deepEqual(await lab.index.pendingRolloutOperations(), []);
  for (const field of ["ticket", "steps", "environment", "expected", "native"]) assert.equal(JSON.stringify(status).includes('"' + field + '"'), false);
  assert.equal(lab.writes(), 1); assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
  assert.equal(await owner.tick("shop", lab.parent.preparation.run), "held"); assert.equal(lab.writes(), 1);
});

test("restart rounds isolate unavailable apps and publish no private port errors", async () => {
  const first = { app: "first", request: randomUUID() }; const second = { app: "second", request: randomUUID() };
  const result = await reconcileRolloutWork({ pendingRolloutOperations: () => Promise.resolve([first, second]) }, {
    tick: (app) => app === first.app ? Promise.reject(new Error("private runtime response")) : Promise.resolve("migrating"),
  });
  assert.deepEqual(result, [{ ...first, outcome: "unavailable" }, { ...second, outcome: "migrating" }]);
  assert.equal(JSON.stringify(result).includes("private"), false);
});
