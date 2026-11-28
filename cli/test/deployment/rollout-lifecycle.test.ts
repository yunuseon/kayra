/* eslint-disable functional/no-let -- owns restart handles and fault injection */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { fixture, commit } from "./http-test-fixture.ts";
import { sequenceFixture } from "./migration-sequence-fixture.ts";
import { completePorts } from "./rollout-plan-fixture.ts";

test("complete rollout admission owns one lifecycle action and reserves the whole plan before any migration", async (t) => {
  const lab = await fixture(t); const jobs = await sequenceFixture(t); const ports = completePorts(lab.ports); const request = randomUUID();
  const execution = { ...lab.artifacts, observeHost: ports.observeHost, now: ports.now, native: jobs.ports.native, materialize: () => Promise.resolve({ RELEASE: "A", TOKEN: "secret-value" }) };
  await assert.rejects(lab.index.prepareRollout("shop", request, commit, ports), /retained build/);
  await lab.index.prepareBuild("shop", commit, lab.builds);
  const prepared = await lab.index.prepareRollout("shop", request, commit, ports);
  assert.equal(prepared.admitted, false); assert.equal(prepared.admissionDeadline, 91_000); assert.equal(prepared.preparation.httpDeadline, null);
  assert.notEqual(prepared.preparation.plan, prepared.preparation.workload);
  await assert.rejects(lab.index.tickRolloutPreparation("shop", request, execution), /admitted lifecycle/);
  await assert.rejects(lab.index.prepareHttpRollout("shop", randomUUID(), commit, lab.ports), /busy or fenced/);
  assert.equal(jobs.nodes.size, 0);
  const admitted = await lab.index.admitRollout("shop", prepared.ticket, ports); assert.equal(admitted?.admitted, true);
  const charge = (await lab.index.resourceSnapshot())?.charges[0]; assert.equal(charge?.target.plan, prepared.preparation.plan);
  assert.equal(charge.deadline, prepared.admissionDeadline); assert.equal(charge.result, "pending");
  for (let number = 0; number < 50; number++) {
    const state = await lab.index.tickRolloutPreparation("shop", request, execution);
    if (state.phase === "ready") break;
  }
  const ready = await lab.index.rolloutOperation("shop", request); assert.equal(ready?.preparation.phase, "ready");
  assert.equal(ready.preparation.sequence?.phase, "succeeded"); assert.equal(ready.preparation.httpDeadline, 91_000);
  assert.equal([...jobs.nodes.values()].reduce((sum, job) => sum + job.executions(), 0), 1);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
  assert.equal((await lab.index.deploymentStatus("shop")).verifiedActive, null);
});

test("indexed preparation recovers a lost migration Start acknowledgement under the same reservation", async (t) => {
  let lose = true;
  const jobs = await sequenceFixture(t, undefined, { afterStart: () => { if (lose) { lose = false; throw new Error("lost migration acknowledgement"); } } });
  const lab = await fixture(t); const ports = completePorts(lab.ports); const request = randomUUID(); let index = lab.index;
  const execution = { ...lab.artifacts, observeHost: ports.observeHost, now: ports.now, native: jobs.ports.native, materialize: () => Promise.resolve({ RELEASE: "A", TOKEN: "secret-value" }) };
  await index.prepareBuild("shop", commit, lab.builds); const prepared = await index.prepareRollout("shop", request, commit, ports);
  await index.admitRollout("shop", prepared.ticket, ports);
  await assert.rejects(async () => { for (let number = 0; number < 50; number++) await index.tickRolloutPreparation("shop", request, execution); }, /lost migration acknowledgement/);
  const before = await index.rolloutOperation("shop", request); await index.close(); index = await openLifecycleAppIndex(lab.path); t.after(() => index.close());
  assert.deepEqual(await index.prepareRollout("shop", request, commit, { ...ports, now: () => 999_999, preview: () => { throw new Error("moving inputs must not be read"); } }), before);
  for (let number = 0; number < 50; number++) { if ((await index.tickRolloutPreparation("shop", request, execution)).phase === "ready") break; }
  const ready = await index.rolloutOperation("shop", request); assert.equal(ready?.preparation.phase, "ready");
  assert.equal(ready.preparation.deadline, prepared.preparation.deadline); assert.equal(ready.admissionDeadline, prepared.admissionDeadline);
  assert.equal([...jobs.nodes.values()].reduce((sum, job) => sum + job.executions(), 0), 1);
});

test("unresolved indexed migration retains lifecycle ownership and capacity without promoting HTTP", async (t) => {
  const lab = await fixture(t); const jobs = await sequenceFixture(t, undefined, { probe: "unknown", afterStart: (job, runtime) => { if (job.scope.purpose === "migration") runtime.state("exited", 1); } });
  const ports = completePorts(lab.ports, true); const request = randomUUID();
  await lab.index.prepareBuild("shop", commit, lab.builds); const prepared = await lab.index.prepareRollout("shop", request, commit, ports);
  await lab.index.admitRollout("shop", prepared.ticket, ports);
  for (let number = 0; number < 70; number++) {
    const state = await lab.index.tickRolloutPreparation("shop", request, { ...lab.artifacts, observeHost: ports.observeHost, now: ports.now, native: jobs.ports.native,
      materialize: () => Promise.resolve({ RELEASE: "A", TOKEN: "secret-value" }) });
    if (state.phase === "held") break;
  }
  const held = await lab.index.rolloutOperation("shop", request); assert.equal(held?.preparation.phase, "held"); assert.equal(held.preparation.httpDeadline, null);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
  await assert.rejects(lab.index.prepareHttpRollout("shop", randomUUID(), commit, lab.ports), /busy or fenced/);
});

test("expired complete rollout admission cannot reserve capacity or start migrations", async (t) => {
  const lab = await fixture(t); const ports = completePorts(lab.ports); await lab.index.prepareBuild("shop", commit, lab.builds);
  const prepared = await lab.index.prepareRollout("shop", randomUUID(), commit, ports);
  await assert.rejects(lab.index.admitRollout("shop", prepared.ticket, { ...ports, now: () => prepared.admissionDeadline }), /deadline expired/);
  assert.equal(await lab.index.resourceSnapshot(), null);
  assert.equal((await lab.index.rolloutOperation("shop", prepared.preparation.run))?.admitted, false);
});
