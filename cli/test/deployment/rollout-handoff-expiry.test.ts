/* eslint-disable functional/no-let -- test journal handles and acknowledgement faults */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { completeRolloutFixture } from "./complete-rollout-fixture.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { parseLifecycleEnvelope } from "../../src/server/deployment/lifecycle-envelope.ts";
import { rolloutExecution } from "../../src/server/deployment/rollout-execution.ts";

test("expired ready preparation seals known applied migrations without HTTP mutation or a new deadline", async (t) => {
  const lab = await completeRolloutFixture(t, false); const ready = await lab.drive((state) => state.preparation.phase === "ready"); assert.ok(ready.preparation.httpDeadline);
  lab.now(ready.preparation.httpDeadline + 1); lab.jobs.now(lab.ports.now()); assert.equal(await lab.owner.tick("shop", lab.parent.preparation.run), "failed");
  const operation = await lab.index.rolloutOperation("shop", lab.parent.preparation.run); assert.equal(operation?.completion?.kind, "expired-handoff");
  assert.equal(operation.preparation.httpDeadline, ready.preparation.httpDeadline); assert.equal(operation.preparation.deadline, ready.preparation.deadline);
  assert.equal(await lab.index.httpOperation("shop", lab.parent.preparation.run), undefined); assert.equal(lab.writes(), 1);
  assert.equal([...lab.jobs.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 2);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "previous");
  const status = await lab.index.deploymentStatus("shop"); assert.equal(status.preparation?.phase, "failed"); assert.equal(status.preparation.reason, "deadline");
  assert.equal(status.preparation.recovery, "previous-preserved"); assert.deepEqual(status.preparation.migrationOutcomes, [{ step: "schema", outcome: "applied" }, { step: "seed", outcome: "applied" }]);
  assert.equal(status.verifiedActive?.plan, lab.initial.plan); assert.equal(status.desired?.plan, lab.initial.plan); assert.equal(status.requiredAction, "none");
});

test("handoff expiry cannot close early or replace the owner of an existing HTTP child", async (t) => {
  const lab = await completeRolloutFixture(t, false); const ready = await lab.drive((state) => state.preparation.phase === "ready"); assert.ok(ready.preparation.httpDeadline);
  await assert.rejects(lab.index.expireRolloutHandoff("shop", lab.parent.preparation.run, ready.preparation.httpDeadline - 1), /not expired/);
  assert.equal((await lab.index.rolloutOperation("shop", lab.parent.preparation.run))?.completion, undefined);
  assert.equal(await lab.owner.tick("shop", lab.parent.preparation.run), "handoff");
  await assert.rejects(lab.index.expireRolloutHandoff("shop", lab.parent.preparation.run, ready.preparation.httpDeadline + 1), /not expired|exclusive/);
  assert.equal((await lab.index.rolloutOperation("shop", lab.parent.preparation.run))?.completion, undefined); assert.equal(lab.writes(), 1);
});

test("lost expiry completion acknowledgement reconstructs failure before releasing its conservative charge", async (t) => {
  const lab = await completeRolloutFixture(t, false); const ready = await lab.drive((state) => state.preparation.phase === "ready"); assert.ok(ready.preparation.httpDeadline);
  lab.now(ready.preparation.httpDeadline + 1); await lab.index.close(); let lose = true;
  const journals: typeof openJournal = async (path, mode) => {
    const journal = await openJournal(path, mode); let poisoned = false;
    return { ...journal, read: () => poisoned ? Promise.reject(new Error("uncertain expiry")) : journal.read(), write: async (value) => {
      if (poisoned) throw new Error("uncertain expiry"); await journal.write(value); const parsed = parseLifecycleEnvelope(value);
      if (lose && parsed.ok && parsed.value.rollout?.completion?.kind === "expired-handoff") { lose = false; poisoned = true; throw new Error("lost expiry completion acknowledgement"); }
    } };
  };
  const interrupted = await openLifecycleAppIndex(lab.path, undefined, journals);
  await assert.rejects(rolloutExecution(interrupted, lab.ports).tick("shop", lab.parent.preparation.run), /lost expiry completion/); await interrupted.close();
  const index = await openLifecycleAppIndex(lab.path); t.after(() => index.close()); const saved = await index.rolloutOperation("shop", lab.parent.preparation.run);
  assert.equal(saved?.completion?.outcome, "failed"); assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "pending");
  assert.equal(await rolloutExecution(index, lab.ports).tick("shop", lab.parent.preparation.run), "failed"); assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "previous");
  assert.equal((await index.rolloutOperation("shop", lab.parent.preparation.run))?.preparation.httpDeadline, ready.preparation.httpDeadline); assert.equal(lab.writes(), 1);
});

test("replaying an expired parent cannot release a newer admitted candidate", async (t) => {
  const lab = await completeRolloutFixture(t, false); const ready = await lab.drive((state) => state.preparation.phase === "ready"); assert.ok(ready.preparation.httpDeadline); lab.now(ready.preparation.httpDeadline + 1);
  await lab.owner.tick("shop", lab.parent.preparation.run); await lab.index.prepareBuild("shop", "c".repeat(40), lab.builds);
  const next = await lab.index.prepareRollout("shop", randomUUID(), "c".repeat(40), lab.plans); await lab.owner.tick("shop", next.preparation.run);
  const before = await lab.index.resourceSnapshot(); assert.equal(before?.charges[0]?.result, "pending"); assert.equal(before.charges[0]?.target.plan, next.preparation.plan);
  await lab.index.expireRolloutHandoff("shop", lab.parent.preparation.run, lab.ports.now() + 300000);
  assert.deepEqual(await lab.index.resourceSnapshot(), before); assert.equal(lab.writes(), 1);
});

test("an accepted cancellation remains cancelled when a stale observer later reports handoff expiry", async (t) => {
  const lab = await completeRolloutFixture(t, false); const ready = await lab.drive((state) => state.preparation.phase === "ready"); assert.ok(ready.preparation.httpDeadline); lab.now(ready.preparation.httpDeadline + 1);
  const cancelled = await lab.index.cancelManagedRollout("shop", lab.parent.preparation.run, lab.ports); assert.equal(cancelled.operation.completion.outcome, "cancelled");
  const stale = await lab.index.expireRolloutHandoff("shop", lab.parent.preparation.run, lab.ports.now()); assert.deepEqual(stale, cancelled.operation);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "previous");
});
