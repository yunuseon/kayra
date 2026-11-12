import { strict as assert } from "node:assert";
import { test } from "node:test";
import { httpExecution } from "../../src/server/deployment/http-execution.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { recoveryFixture } from "./http-recovery-fixture.ts";

test("unstarted cancellation seals its receipt before freeing the admitted overlap charge", async (t) => {
  const lab = await recoveryFixture(t); const b = await lab.start("b".repeat(40));
  await lab.execution.tick("shop", b.request);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
  const cancelled = await lab.index.cancelHttpRollout("shop", b.request, 3000);
  assert.equal(cancelled?.phase, "cancelled"); assert.equal(cancelled.cancelRequestedAt, 3000);
  assert.equal(cancelled.recovery?.kind, "unstarted"); assert.equal(lab.writes(), 1);
  assert.deepEqual(await lab.index.cancelHttpRollout("shop", b.request, 999999), cancelled);
  const c = await lab.start("c".repeat(40));
  assert.equal(c.previous?.plan, lab.initial.plan);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "previous");
});

test("a cancelled initial request needs no runtime effect or speculative capacity release", async (t) => {
  const lab = await recoveryFixture(t, false); const a = lab.initial;
  await lab.index.cancelHttpRollout("shop", a.request, 3000);
  assert.equal(await lab.execution.tick("shop", a.request), "cancelled");
  assert.equal(lab.writes(), 0); assert.equal(await lab.index.resourceSnapshot(), null);
  const status = await lab.index.deploymentStatus("shop");
  assert.equal(status.verifiedActive, null); assert.equal(status.desired, null); assert.equal(status.operation?.cancelRequestedAt, 3000);
});

test("a dispatched candidate is restored before cancellation can become terminal", async (t) => {
  const lab = await recoveryFixture(t); const b = await lab.start("b".repeat(40));
  await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request);
  const original = await lab.index.httpOperation("shop", b.request); assert.ok(original?.steps[0] !== undefined);
  const cancelled = await lab.index.cancelHttpRollout("shop", b.request, 3000);
  assert.equal(cancelled?.phase, "recovering"); assert.equal(cancelled.cancelRequestedAt, 3000);
  assert.equal(await lab.index.authorizeHttpNative("shop", b.ticket, original.steps[0]), false);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
  lab.now(3000);
  assert.equal(await lab.execution.tick("shop", b.request), "acknowledged");
  assert.equal(await lab.execution.tick("shop", b.request), "cancelled");
  const final = await lab.index.httpOperation("shop", b.request);
  assert.equal(final?.recovery?.kind, "compensated"); assert.equal(final.cancelRequestedAt, 3000);
  const status = await lab.index.deploymentStatus("shop");
  assert.equal(status.requested?.plan, b.plan); assert.equal(status.desired?.plan, lab.initial.plan);
  assert.equal(status.verifiedActive?.plan, lab.initial.plan); assert.equal(status.operation?.phase, "cancelled");
  await lab.execution.tick("shop", b.request);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "previous");
});

test("cancellation preserves an existing recovery deadline and remains visible after expiry holds the operation", async (t) => {
  const lab = await recoveryFixture(t); const b = await lab.start("b".repeat(40));
  await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request);
  const recovery = await lab.index.beginHttpRecovery("shop", b.ticket, "runtime", 3000);
  const cancelled = await lab.index.cancelHttpRollout("shop", b.request, 4000);
  assert.ok(cancelled !== undefined);
  assert.equal(cancelled.recoveryDeadline, recovery?.recoveryDeadline);
  await lab.index.close(); const reopened = await openLifecycleAppIndex(lab.path); t.after(() => reopened.close());
  assert.deepEqual(await reopened.cancelHttpRollout("shop", b.request, 5000), cancelled);
  assert.ok(cancelled.recoveryDeadline !== null);
  lab.now(cancelled.recoveryDeadline + 1);
  assert.equal(await httpExecution(reopened, lab.ports).tick("shop", b.request), "held");
  const held = await reopened.deploymentStatus("shop");
  assert.equal(held.operation?.cancelRequestedAt, 4000); assert.equal(held.operation.recoveryDeadline, recovery?.recoveryDeadline);
  assert.equal(held.requiredAction, "inspect-and-resolve"); assert.equal((await reopened.resourceSnapshot())?.charges[0]?.result, "pending");
  assert.equal((await reopened.cancelHttpRollout("shop", b.request, 999999))?.phase, "held");
  assert.equal(lab.writes(), 1);
});

test("late cancellation cannot change a verified release or a newer operation", async (t) => {
  const lab = await recoveryFixture(t);
  const before = await lab.index.httpOperation("shop", lab.initial.request);
  const b = await lab.start("b".repeat(40)); await lab.execution.tick("shop", b.request);
  assert.deepEqual(await lab.index.cancelHttpRollout("shop", lab.initial.request, 3000), before);
  assert.equal((await lab.index.httpOperation("shop", b.request))?.phase, "admitted");
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
});

test("a pending old write cannot arrive after cancellation has certified unchanged A", async (t) => {
  const lab = await recoveryFixture(t); const b = await lab.start("b".repeat(40));
  await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request);
  const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>();
  // eslint-disable-next-line functional/no-let -- owns the late native callback result
  let late = "unobserved";
  const old = httpExecution(lab.index, { ...lab.ports, native: { ...lab.ports.native, apply: async (...args) => {
    entered.resolve(undefined); await release.promise; const result = await lab.ports.native.apply(...args); late = result; return result;
  } } });
  const pending = old.tick("shop", b.request);
  const rejected = assert.rejects(pending, /no longer owns lifecycle/);
  t.after(() => { release.resolve(undefined); });
  await entered.promise; lab.now(3000);
  await lab.index.cancelHttpRollout("shop", b.request, 3000);
  const recovered = httpExecution(lab.index, lab.ports);
  assert.equal(await recovered.tick("shop", b.request), "acknowledged");
  assert.equal(await recovered.tick("shop", b.request), "cancelled");
  release.resolve(undefined); await rejected;
  assert.equal(late, "conflict"); assert.equal(lab.writes(), 2);
  assert.equal((await lab.index.httpOperation("shop", b.request))?.recovery?.kind, "previous-preserved");
  assert.equal((await lab.index.deploymentStatus("shop")).verifiedActive?.plan, lab.initial.plan);
});

test("an accepted restoration waits for its task instead of dispatching another restore during scheduling delay", async (t) => {
  const lab = await recoveryFixture(t); const b = await lab.start("b".repeat(40));
  await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request);
  lab.now(3000); await lab.index.cancelHttpRollout("shop", b.request, 3000);
  assert.equal(await lab.execution.tick("shop", b.request), "acknowledged");
  const restored = lab.current(); assert.equal(restored.status, "owned");
  const writes = lab.writes(); lab.set({ ...restored, tasks: [], update: "updating" });
  const recovering = httpExecution(lab.index, { ...lab.ports, native: { ...lab.ports.native, observeDesired: (action) => {
    const observed = lab.current();
    return Promise.resolve(observed.status !== "owned" ? observed : { ...observed,
      specMatches: observed.taskPlan === action.plan && observed.taskEffect === action.effect && observed.action === action.action });
  } } });
  for (const attempt of [1, 2, 3]) assert.equal(await recovering.tick("shop", b.request), "recovering", String(attempt));
  assert.equal(lab.writes(), writes);
  assert.equal((await lab.index.httpOperation("shop", b.request))?.steps.filter((step) => step.effect === "restore").length, 1);
  lab.set(restored); assert.equal(await recovering.tick("shop", b.request), "cancelled");
});
