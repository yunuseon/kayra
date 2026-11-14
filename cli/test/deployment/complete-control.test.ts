import { parseRolloutPlan } from "../../src/contracts/rollout-plan.ts";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { registrationControl } from "../../src/server/deployment/registration-control.ts";
import { deploymentControl } from "../../src/server/deployment/deployment-control.ts";
import { parseCompleteDeploymentReceipt, parseDeploymentReceipt } from "../../src/contracts/deployment-request.ts";
import { rolloutExecution } from "../../src/server/deployment/rollout-execution.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { completeRolloutFixture } from "./complete-rollout-fixture.ts";
import { recoveryFixture } from "./http-recovery-fixture.ts";

const allow = () => Promise.resolve(true);
test("complete control prepares migrations under a full-plan receipt and promotes only after routed convergence", async (t) => {
  const lab = await completeRolloutFixture(t, false); await lab.index.cancelUnstartedRollout("shop", lab.parent.preparation.run, lab.ports.now());
  const control = deploymentControl({ index: lab.index, now: lab.ports.now, canAccess: allow, enabled: allow, rollouts: lab.plans });
  const input = { app: "shop", commit: "b".repeat(40), request: randomUUID() }; const receipt = parseCompleteDeploymentReceipt(await control("/deployment/prepare", input)); assert.ok(receipt.ok);
  assert.equal(receipt.value.phase, "prepared"); assert.equal(lab.writes(), 1); assert.equal(await lab.index.httpOperation("shop", input.request), undefined);
  const owner = rolloutExecution(lab.index, lab.ports);
  // eslint-disable-next-line functional/no-let -- observes a bounded state-machine progression
  let outcome = "prepared";
  // eslint-disable-next-line functional/no-let -- bounded reconciliation rounds
  for (let round = 0; round < 80 && outcome !== "succeeded"; round++) outcome = await owner.tick("shop", input.request);
  assert.equal(outcome, "succeeded"); const status = await lab.index.deploymentStatus("shop"); assert.equal(status.verifiedActive?.plan, receipt.value.plan); assert.equal(status.requiredAction, "none");
  assert.equal([...lab.jobs.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 2); assert.equal(lab.writes(), 2);
  const repeated = parseCompleteDeploymentReceipt(await control("/deployment/prepare", input)); assert.ok(repeated.ok); assert.equal(repeated.value.phase, "succeeded"); assert.equal(repeated.value.deadline, receipt.value.deadline);
  await assert.rejects(control("/deployment/prepare", { ...input, commit: "c".repeat(40) }), /conflicting commit/);
});

test("restart returns the complete ready request without recompilation or a fresh deadline", async (t) => {
  const lab = await completeRolloutFixture(t, false); const ready = await lab.drive((state) => state.preparation.phase === "ready"); await lab.index.close();
  const index = await openLifecycleAppIndex(lab.path); t.after(() => index.close());
  const control = deploymentControl({ index, now: lab.ports.now, canAccess: allow, enabled: allow,
    rollouts: { ...lab.plans, preview: () => Promise.reject(new Error("must not recompile retained intent")) } });
  const input = { app: "shop", commit: ready.commit, request: ready.preparation.run }; const receipt = parseCompleteDeploymentReceipt(await control("/deployment/prepare", input)); assert.ok(receipt.ok);
  assert.equal(receipt.value.phase, "ready-for-http"); assert.equal(receipt.value.deadline, ready.preparation.deadline); assert.equal(receipt.value.plan, ready.preparation.plan);
  assert.equal(await index.httpOperation("shop", input.request), undefined); assert.equal(lab.writes(), 1);
});

test("enabling complete plans still reconstructs a legacy HTTP request under its original receipt", async (t) => {
  const lab = await recoveryFixture(t); const control = deploymentControl({ index: lab.index, now: lab.ports.now, canAccess: allow, enabled: allow,
    rollouts: { ...lab.ports, preview: () => Promise.reject(new Error("must not convert existing HTTP intent")) } });
  const answer = parseDeploymentReceipt(await control("/deployment/prepare", { app: "shop", commit: lab.initial.commit, request: lab.initial.request })); assert.ok(answer.ok);
  assert.equal(answer.value.plan, lab.initial.plan); assert.equal(answer.value.deadline, lab.initial.deadline); assert.equal(answer.value.phase, "succeeded");
  await assert.rejects(control("/deployment/prepare", { app: "shop", commit: "b".repeat(40), request: lab.initial.request }), /conflicting commit/);
});

test("complete control rejects unsupported input or proposals before creating a candidate", async (t) => {
  const lab = await completeRolloutFixture(t, false); await lab.index.cancelUnstartedRollout("shop", lab.parent.preparation.run, lab.ports.now()); const before = await lab.index.resourceSnapshot();
  const input = { app: "shop", commit: "b".repeat(40), request: randomUUID() };
  const ports = { index: lab.index, now: lab.ports.now, canAccess: allow, enabled: allow, rollouts: lab.plans };
  await assert.rejects(deploymentControl({ ...ports, enabled: () => Promise.resolve(false) })("/deployment/prepare", input), /unavailable/);
  await assert.rejects(deploymentControl({ ...ports, canAccess: () => Promise.resolve(false) })("/deployment/prepare", input), /outside scope/);
  assert.equal(await deploymentControl(ports)("/deployment/prepare", { ...input, runtime: "compose" }), undefined);
  const control = deploymentControl({ ...ports, rollouts: { ...lab.plans, preview: async (...args) => ({ ...await lab.plans.preview(...args), unsupported: true }) } });
  await assert.rejects(control("/deployment/prepare", input), /invalid immutable/); assert.equal(await lab.index.rolloutOperation("shop", input.request), undefined); assert.deepEqual(await lab.index.resourceSnapshot(), before); assert.equal(lab.writes(), 1);
});

test("complete preview exposes the migration policy without admission and refuses foreign plan scope", async (t) => {
  const lab = await completeRolloutFixture(t, false); const before = await lab.index.resourceSnapshot();
  const control = registrationControl({ index: lab.index, canRegister: allow, rollouts: lab.plans });
  const answer = await control("/registration/preview", { app: "shop", commit: "b".repeat(40) });
  const expected = parseRolloutPlan(JSON.parse(await lab.ports.read(lab.parent.preparation.plan))); assert.ok(expected.ok);
  assert.deepEqual(answer, { admitted: false, plan: expected.value }); assert.deepEqual(await lab.index.resourceSnapshot(), before); assert.equal(lab.writes(), 1);
  const foreign = registrationControl({ index: lab.index, canRegister: allow, rollouts: { ...lab.plans, preview: async (...args) => {
    const plan = await lab.plans.preview(...args); return { ...plan, workload: { ...plan.workload, commit: "c".repeat(40) } };
  } } });
  await assert.rejects(foreign("/registration/preview", { app: "shop", commit: "b".repeat(40) }), /ownership mismatch/);
  const denied = registrationControl({ index: lab.index, canRegister: () => Promise.resolve(false), rollouts: lab.plans });
  await assert.rejects(denied("/registration/preview", { app: "shop", commit: "b".repeat(40) }), /outside preview scope/);
});
