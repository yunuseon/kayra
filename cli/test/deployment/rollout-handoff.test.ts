/* eslint-disable functional/no-let -- owns test clock and restarted coordinator handles */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { recoveryFixture } from "./http-recovery-fixture.ts";
import { sequenceFixture } from "./migration-sequence-fixture.ts";
import { completePorts } from "./rollout-plan-fixture.ts";
import { httpExecution } from "../../src/server/deployment/http-execution.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";

test("migrations hand their existing action and reservation to HTTP, with complete release identity", async (t) => {
  const lab = await recoveryFixture(t); const jobs = await sequenceFixture(t); let index = lab.index; let clock = 3000;
  const ports = { ...completePorts(lab.ports), now: () => clock };
  const preparation = { ...lab.artifacts, native: jobs.ports.native, now: ports.now, materialize: () => Promise.resolve({ TOKEN: "secret-value", RELEASE: "A" }) };
  const request = randomUUID(); const commit = "b".repeat(40);
  await index.prepareBuild("shop", commit, { ...lab.builds, now: ports.now }); const parent = await index.prepareRollout("shop", request, commit, ports);
  await index.admitRollout("shop", parent.ticket, ports);
  await assert.rejects(index.handoffRollout("shop", request, ports), /not ready/);
  assert.equal(await index.httpOperation("shop", request), undefined);
  clock = 5000; jobs.now(clock);
  for (let count = 0; count < 50; count++) { if ((await index.tickRolloutPreparation("shop", request, preparation)).phase === "ready") break; }
  const ready = await index.rolloutOperation("shop", request); assert.equal(ready?.preparation.phase, "ready");
  const http = await index.handoffRollout("shop", request, ports);
  assert.equal(http.ticket, parent.ticket); assert.equal(http.action, parent.action); assert.equal(http.phase, "admitted");
  assert.equal(http.deployment, parent.preparation.plan); assert.equal(http.plan, parent.preparation.workload);
  assert.equal(http.deadline, 95_000); assert.equal((await index.resourceSnapshot())?.charges[0]?.deadline, 93_000);
  assert.deepEqual(await index.pendingHttpOperations(), []);
  assert.deepEqual(await index.pendingRolloutOperations(), [{ app: "shop", request }]);
  await index.close(); index = await openLifecycleAppIndex(lab.path); t.after(() => index.close());
  assert.deepEqual(await index.handoffRollout("shop", request, { ...ports, now: () => 8000 }), http);
  lab.now(6000); const execution = httpExecution(index, lab.ports);
  for (const expected of ["applying", "verifying", "succeeded"]) assert.equal(await execution.tick("shop", request), expected);
  const sealed = await index.httpOperation("shop", request); assert.equal(sealed?.verified?.deployment, parent.preparation.plan);
  assert.equal(sealed.verified.plan, parent.preparation.workload);
  const status = await index.deploymentStatus("shop"); assert.equal(status.requested?.plan, parent.preparation.plan); assert.equal(status.verifiedActive?.plan, parent.preparation.plan);
  assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "target");
  assert.equal([...jobs.nodes.values()].reduce((sum, job) => sum + job.executions(), 0), 1);
  await assert.rejects(index.prepareHttpRollout("shop", randomUUID(), commit, lab.ports), /requires complete rollout/);
});

test("complete release history survives another rollout and compensation restores its whole-plan certificate", async (t) => {
  const lab = await recoveryFixture(t); const jobs = await sequenceFixture(t); const ports = completePorts(lab.ports);
  jobs.now(ports.now());
  const preparation = { ...lab.artifacts, native: jobs.ports.native, now: ports.now, materialize: () => Promise.resolve({ TOKEN: "secret-value", RELEASE: "A" }) };
  const start = async (commit: string) => {
    await lab.index.prepareBuild("shop", commit, lab.builds); const parent = await lab.index.prepareRollout("shop", randomUUID(), commit, ports);
    await lab.index.admitRollout("shop", parent.ticket, ports);
    for (let count = 0; count < 50; count++) { if ((await lab.index.tickRolloutPreparation("shop", parent.preparation.run, preparation)).phase === "ready") break; }
    return { parent, http: await lab.index.handoffRollout("shop", parent.preparation.run, ports) };
  };
  const first = await start("b".repeat(40));
  for (const expected of ["applying", "verifying", "succeeded"]) assert.equal(await lab.execution.tick("shop", first.http.request), expected);
  const second = await start("c".repeat(40));
  assert.equal(second.http.previous?.deployment, first.parent.preparation.plan);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.previous?.plan, first.parent.preparation.plan);
  await lab.execution.tick("shop", second.http.request); await lab.execution.tick("shop", second.http.request);
  const native = lab.current(); assert.equal(native.status, "owned"); lab.set({ ...native, update: "paused" });
  assert.equal(await lab.execution.tick("shop", second.http.request), "recovering");
  for (let count = 0; count < 10; count++) { if (await lab.execution.tick("shop", second.http.request) === "failed") break; }
  const failed = await lab.index.httpOperation("shop", second.http.request); assert.equal(failed?.phase, "failed");
  assert.equal(failed.recovery?.verified?.deployment, first.parent.preparation.plan);
  const status = await lab.index.deploymentStatus("shop"); assert.equal(status.requested?.plan, second.parent.preparation.plan);
  assert.equal(status.desired?.plan, first.parent.preparation.plan); assert.equal(status.verifiedActive?.plan, first.parent.preparation.plan);
  await lab.execution.tick("shop", second.http.request); assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "previous");
  assert.deepEqual(await lab.index.prepareRollout("shop", first.http.request, "b".repeat(40), { ...ports, preview: () => { throw new Error("historical inputs must not be rebuilt"); } }),
    { ...first.parent, admitted: true, preparation: (await lab.index.rolloutOperation("shop", first.http.request))?.preparation });
});

test("a persisted but expired HTTP handoff cannot mint another deadline or consume another action", async (t) => {
  const lab = await recoveryFixture(t); const jobs = await sequenceFixture(t); let clock = 3000; const ports = { ...completePorts(lab.ports), now: () => clock };
  jobs.now(clock);
  await lab.index.prepareBuild("shop", "b".repeat(40), lab.builds); const parent = await lab.index.prepareRollout("shop", randomUUID(), "b".repeat(40), ports);
  await lab.index.admitRollout("shop", parent.ticket, ports);
  for (let count = 0; count < 50; count++) {
    if ((await lab.index.tickRolloutPreparation("shop", parent.preparation.run, { ...lab.artifacts, native: jobs.ports.native, now: ports.now,
      materialize: () => Promise.resolve({ TOKEN: "secret-value", RELEASE: "A" }) })).phase === "ready") break;
  }
  const ready = await lab.index.rolloutOperation("shop", parent.preparation.run); assert.ok(ready?.preparation.httpDeadline);
  clock = ready.preparation.httpDeadline;
  await assert.rejects(lab.index.handoffRollout("shop", parent.preparation.run, ports), /deadline expired/);
  assert.equal(await lab.index.httpOperation("shop", parent.preparation.run), undefined);
  assert.deepEqual(await lab.index.rolloutOperation("shop", parent.preparation.run), ready);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
});
