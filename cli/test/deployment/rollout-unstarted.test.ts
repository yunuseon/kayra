/* eslint-disable functional/no-let, functional/prefer-immutable-types -- owns test fixtures and bounded reconciliation loops */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixture } from "./http-test-fixture.ts";
import { recoveryFixture } from "./http-recovery-fixture.ts";
import { sequenceFixture } from "./migration-sequence-fixture.ts";
import { completePorts } from "./rollout-plan-fixture.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { parseLifecycleEnvelope } from "../../src/server/deployment/lifecycle-envelope.ts";
import { rolloutExecution } from "../../src/server/deployment/rollout-execution.ts";

const start = async (lab: Awaited<ReturnType<typeof fixture>>, commit = "b".repeat(40)) => {
  const ports = completePorts(lab.ports); await lab.index.prepareBuild("shop", commit, lab.builds);
  return { ports, parent: await lab.index.prepareRollout("shop", randomUUID(), commit, ports) };
};

test("cancellation before admission records unstarted intent without inventing capacity or active state", async (t) => {
  const lab = await fixture(t); const { parent } = await start(lab);
  const cancelled = await lab.index.cancelUnstartedRollout("shop", parent.preparation.run, 2000);
  assert.equal(cancelled.completion?.outcome, "cancelled"); assert.equal(cancelled.completion.kind, "unstarted"); assert.equal(cancelled.completion.previous, null);
  assert.equal(cancelled.preparation.deadline, parent.preparation.deadline); assert.equal(await lab.index.resourceSnapshot(), null);
  assert.deepEqual(await lab.index.cancelUnstartedRollout("shop", parent.preparation.run, -1), cancelled);
  const status = await lab.index.deploymentStatus("shop"); assert.equal(status.preparation?.phase, "cancelled"); assert.equal(status.preparation.completedAt, 2000);
  assert.equal(status.requested?.plan, parent.preparation.plan); assert.equal(status.desired, null); assert.equal(status.verifiedActive, null); assert.equal(status.requiredAction, "none");
  assert.deepEqual(await lab.index.pendingRolloutOperations(), []);
  const next = await start(lab, "c".repeat(40)); assert.notEqual(next.parent.action, parent.action);
  await lab.index.admitRollout("shop", next.parent.ticket, next.ports); assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
  assert.deepEqual(await lab.index.cancelUnstartedRollout("shop", parent.preparation.run, 9999), cancelled);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.sequence, Number(next.parent.action.split(":")[1]));
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
});

test("cancellation after reservation requires no runtime observation and releases only its admitted peak", async (t) => {
  const lab = await fixture(t); const { parent, ports } = await start(lab); await lab.index.admitRollout("shop", parent.ticket, ports);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
  await lab.index.cancelUnstartedRollout("shop", parent.preparation.run, 2000);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "absent");
  await assert.rejects(lab.index.admitRollout("shop", parent.ticket, ports), /no longer owns lifecycle/);
  await assert.rejects(lab.index.tickRolloutPreparation("shop", parent.preparation.run, { ...lab.artifacts, now: ports.now,
    native: { observe: () => { throw new Error("runtime must not be read"); }, create: () => { throw new Error("runtime must not be mutated"); },
      start: () => { throw new Error("runtime must not be mutated"); }, fence: () => { throw new Error("runtime must not be mutated"); } },
    materialize: () => { throw new Error("secrets must not be materialized"); } }), /admitted lifecycle/);
});

test("expired admission without a reservation settles failure while preserving the verified previous release", async (t) => {
  const lab = await recoveryFixture(t); const jobs = await sequenceFixture(t); const { parent } = await start(lab);
  const now = parent.admissionDeadline + 1;
  const execution = rolloutExecution(lab.index, { ...lab.ports, ...lab.artifacts, jobs: jobs.ports.native, now: () => now });
  assert.equal(await execution.tick("shop", parent.preparation.run), "failed"); assert.equal(jobs.nodes.size, 0); assert.equal(lab.writes(), 1);
  const status = await lab.index.deploymentStatus("shop"); assert.equal(status.preparation?.phase, "failed"); assert.equal(status.preparation.reason, "deadline");
  assert.equal(status.requested?.plan, parent.preparation.plan); assert.equal(status.desired?.plan, lab.initial.plan); assert.equal(status.verifiedActive?.plan, lab.initial.plan);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.target.plan, lab.initial.plan);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "target"); assert.deepEqual(await lab.index.pendingRolloutOperations(), []);
});

test("restart after resource reservation but before its app marker preserves the original admission", async (t) => {
  const lab = await recoveryFixture(t); const jobs = await sequenceFixture(t); const { parent, ports } = await start(lab);
  await lab.index.admitRollout("shop", parent.ticket, ports); await lab.index.close();
  const path = join(lab.path, createHash("sha256").update("shop").digest("hex"), "state.json");
  const raw: unknown = JSON.parse(await readFile(path, "utf8")); const parsed = parseLifecycleEnvelope(raw); assert.ok(parsed.ok); assert.ok(parsed.value.rollout);
  // This is the exact state between the synchronized host reservation and app admission write.
  await writeFile(path, JSON.stringify({ ...parsed.value, rollout: { ...parsed.value.rollout, admitted: false } }));
  const index = await openLifecycleAppIndex(lab.path); t.after(() => index.close()); const now = parent.admissionDeadline + 1; jobs.now(now); lab.now(now);
  const execution = rolloutExecution(index, { ...lab.ports, ...lab.artifacts, jobs: jobs.ports.native, now: () => now,
    materialize: () => Promise.resolve({ RELEASE: "A", TOKEN: "private-value" }) });
  assert.equal(await execution.tick("shop", parent.preparation.run), "admitted");
  assert.equal((await index.resourceSnapshot())?.charges[0]?.deadline, parent.admissionDeadline);
  for (let count = 0; count < 100; count++) { if (await execution.tick("shop", parent.preparation.run) === "succeeded") break; }
  assert.equal((await index.httpOperation("shop", parent.preparation.run))?.phase, "succeeded");
  assert.equal((await index.rolloutOperation("shop", parent.preparation.run))?.preparation.deadline, parent.preparation.deadline);
  assert.equal([...jobs.nodes.values()].reduce((sum, job) => sum + job.executions(), 0), 1);
});

test("restart settles a cancelled operation's conservative reservation from its sealed proof", async (t) => {
  const lab = await recoveryFixture(t); const jobs = await sequenceFixture(t); const { parent, ports } = await start(lab);
  await lab.index.admitRollout("shop", parent.ticket, ports); const pending = await lab.index.resourceSnapshot();
  await lab.index.cancelUnstartedRollout("shop", parent.preparation.run, 3000); await lab.index.close();
  const path = join(lab.path, "state.json"); const raw: unknown = JSON.parse(await readFile(path, "utf8")); assert.ok(typeof raw === "object" && raw !== null);
  // The app completion committed; the subsequent resource settlement did not.
  await writeFile(path, JSON.stringify({ ...raw, resources: pending })); const index = await openLifecycleAppIndex(lab.path); t.after(() => index.close());
  assert.deepEqual(await index.pendingRolloutOperations(), [{ app: "shop", request: parent.preparation.run }]);
  assert.equal(await rolloutExecution(index, { ...lab.ports, ...lab.artifacts, jobs: jobs.ports.native }).tick("shop", parent.preparation.run), "cancelled");
  assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "previous"); assert.equal(jobs.nodes.size, 0); assert.deepEqual(await index.pendingRolloutOperations(), []);
});

test("a new request reconciles a previous cancelled reservation before archiving that parent", async (t) => {
  const lab = await fixture(t); const { parent, ports } = await start(lab); await lab.index.admitRollout("shop", parent.ticket, ports);
  const pending = await lab.index.resourceSnapshot(); await lab.index.cancelUnstartedRollout("shop", parent.preparation.run, 2000); await lab.index.close();
  const path = join(lab.path, "state.json"); const raw: unknown = JSON.parse(await readFile(path, "utf8")); assert.ok(typeof raw === "object" && raw !== null);
  await writeFile(path, JSON.stringify({ ...raw, resources: pending })); const index = await openLifecycleAppIndex(lab.path); t.after(() => index.close());
  await index.prepareBuild("shop", "c".repeat(40), lab.builds);
  const next = await index.prepareRollout("shop", randomUUID(), "c".repeat(40), ports); assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "absent");
  await index.admitRollout("shop", next.ticket, ports); assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "pending");
  const cancelled = await index.cancelUnstartedRollout("shop", parent.preparation.run, 3000); assert.equal(cancelled.completion?.outcome, "cancelled");
  assert.equal((await index.resourceSnapshot())?.charges[0]?.target.plan, next.preparation.plan); assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "pending");
});

test("unstarted cancellation cannot infer safety from runtime absence after migration intent exists", async (t) => {
  const lab = await fixture(t); const jobs = await sequenceFixture(t); const { parent, ports } = await start(lab); await lab.index.admitRollout("shop", parent.ticket, ports);
  await lab.index.tickRolloutPreparation("shop", parent.preparation.run, { ...lab.artifacts, native: jobs.ports.native, now: ports.now, materialize: () => Promise.resolve({ RELEASE: "A", TOKEN: "private-value" }) });
  assert.equal(jobs.nodes.size, 0);
  await assert.rejects(lab.index.cancelUnstartedRollout("shop", parent.preparation.run, 2000), /may have effects/);
  assert.equal((await lab.index.rolloutOperation("shop", parent.preparation.run))?.completion, undefined);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
});
