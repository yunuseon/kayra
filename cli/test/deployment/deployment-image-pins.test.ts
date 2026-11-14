import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { parseDeploymentImagePins } from "../../src/contracts/deployment-image-pins.ts";
import { deploymentControl } from "../../src/server/deployment/deployment-control.ts";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { recoveryFixture } from "./http-recovery-fixture.ts";
import { completeRolloutFixture } from "./complete-rollout-fixture.ts";

const allow = () => Promise.resolve(true);
test("pins preserve active and full candidate identities without inputs, effects or GC authority", async (t) => {
  const lab = await completeRolloutFixture(t, false); const before = await lab.index.resourceSnapshot();
  const control = deploymentControl({ index: lab.index, artifacts: lab.artifacts, canAccess: allow, now: lab.ports.now, enabled: () => Promise.resolve(false) });
  const result = parseDeploymentImagePins(await control("/deployment/pins", { app: "shop" })); assert.ok(result.ok);
  const pins = result.value; assert.equal(pins.gcSafe, false); assert.equal(pins.scope, "coordinator-plans"); assert.equal(pins.plans.length, 2);
  assert.deepEqual(pins.plans.find((item) => item.plan === lab.initial.plan)?.roles, ["active", "last-known-good"]);
  const candidate = pins.plans.find((item) => item.plan === lab.parent.preparation.plan); assert.ok(candidate);
  assert.equal(candidate.workload, lab.parent.preparation.workload); assert.notEqual(candidate.plan, candidate.workload); assert.deepEqual(candidate.roles, ["candidate"]);
  assert.ok(pins.plans.every((item) => item.images.length === 1 && item.images[0]?.startsWith("localhost:5000/shop/web@sha256:")));
  assert.equal(lab.jobs.nodes.size, 0); assert.equal(lab.writes(), 1); assert.deepEqual(await lab.index.resourceSnapshot(), before);
  assert.equal(JSON.stringify(pins).includes("private-value"), false); assert.equal(JSON.stringify(pins).includes("environment"), false); assert.ok(Object.isFrozen(pins.plans[0]?.images));
});

test("promotion exports the new active plan and previous rollback plan across restart", async (t) => {
  const lab = await completeRolloutFixture(t, false); await lab.drive((item) => item.preparation.phase === "ready");
  // eslint-disable-next-line functional/no-let -- bounded reconciliation until HTTP convergence
  let outcome = "ready";
  // eslint-disable-next-line functional/no-let -- bounded reconciliation rounds
  for (let round = 0; round < 60 && outcome !== "succeeded"; round++) outcome = await lab.owner.tick("shop", lab.parent.preparation.run);
  assert.equal(outcome, "succeeded"); const pins = await lab.index.deploymentImagePins("shop", lab.artifacts);
  assert.deepEqual(pins.plans.find((item) => item.plan === lab.initial.plan)?.roles, ["rollback"]);
  assert.deepEqual(pins.plans.find((item) => item.plan === lab.parent.preparation.plan)?.roles, ["active", "last-known-good"]);
  await lab.index.close(); const index = await openLifecycleAppIndex(lab.path); t.after(() => index.close()); assert.deepEqual(await index.deploymentImagePins("shop", lab.artifacts), pins);
});

test("held migration plans remain pinned and cancelled unstarted candidates stop contributing", async (t) => {
  const held = await completeRolloutFixture(t, true, "unknown", true); await held.drive((item) => item.preparation.phase === "held");
  const pins = await held.index.deploymentImagePins("shop", held.artifacts); assert.deepEqual(pins.plans.find((item) => item.plan === held.parent.preparation.plan)?.roles, ["unresolved"]);
  const cancelled = await completeRolloutFixture(t, false); await cancelled.index.cancelUnstartedRollout("shop", cancelled.parent.preparation.run, cancelled.ports.now());
  const settled = await cancelled.index.deploymentImagePins("shop", cancelled.artifacts); assert.equal(settled.plans.some((item) => item.plan === cancelled.parent.preparation.plan), false); assert.equal(settled.plans.length, 1);
});

test("missing or corrupt immutable plans refuse a partial pin snapshot", async (t) => {
  const lab = await completeRolloutFixture(t, false);
  await assert.rejects(lab.index.deploymentImagePins("shop", { read: (digest) => digest === lab.parent.preparation.plan ? Promise.reject(new Error("artifact unavailable")) : lab.artifacts.read(digest) }), /artifact unavailable/);
  await assert.rejects(lab.index.deploymentImagePins("shop", { read: () => Promise.resolve("{}") }), /integrity/);
});

test("pin control scopes the query and legacy Compose never claims a complete runtime inventory", async (t) => {
  const lab = await completeRolloutFixture(t, false);
  const denied = deploymentControl({ index: lab.index, artifacts: lab.artifacts, canAccess: () => Promise.resolve(false), now: lab.ports.now, enabled: allow });
  await assert.rejects(denied("/deployment/pins", { app: "shop" }), /outside deployment scope/);
  assert.equal(await denied("/deployment/pins", { app: "shop", runtime: "swarm" }), undefined);
  const unavailable = deploymentControl({ index: lab.index, canAccess: allow, now: lab.ports.now, enabled: allow }); assert.equal(await unavailable("/deployment/pins", { app: "shop" }), undefined);
  const index = await createLifecycleAppIndex(join(lab.path, "legacy"), (identity) => Promise.resolve({ ...identity, status: "applied" })); t.after(() => index.close());
  await index.prepareApp("shop"); const generation = randomUUID(); const ticket = await index.reserveRegistration("shop", generation);
  await index.submitRegistration("shop", ticket, generation); await index.reconcileRegistration("shop", ticket, generation);
  const legacy = await index.deploymentImagePins("shop", lab.artifacts); assert.equal(legacy.runtime, "compose"); assert.deepEqual(legacy.plans, []); assert.equal(legacy.gcSafe, false);
});

test("the shared pin contract rejects foreign image ownership, duplicate roles and invented GC authority", async (t) => {
  const lab = await completeRolloutFixture(t, false); const pins = await lab.index.deploymentImagePins("shop", lab.artifacts); const first = pins.plans[0]; assert.ok(first);
  assert.equal(parseDeploymentImagePins({ ...pins, gcSafe: true }).ok, false);
  assert.equal(parseDeploymentImagePins({ ...pins, plans: [{ ...first, images: ["localhost:5000/other/web@sha256:" + "d".repeat(64)] }] }).ok, false);
  assert.equal(parseDeploymentImagePins({ ...pins, plans: [{ ...first, roles: ["active", "active"] }] }).ok, false);
  assert.equal(parseDeploymentImagePins({ ...pins, plans: [first, first] }).ok, false);
});

test("an unresolved native HTTP replacement retains its target and previous rollback images", async (t) => {
  const lab = await recoveryFixture(t); const candidate = await lab.start("b".repeat(40));
  const before = await lab.index.deploymentImagePins("shop", lab.artifacts);
  assert.deepEqual(before.plans.find((item) => item.plan === lab.initial.plan)?.roles, ["active", "last-known-good", "rollback"]);
  assert.deepEqual(before.plans.find((item) => item.plan === candidate.plan)?.roles, ["candidate"]);
  await lab.index.holdHttp("shop", candidate.ticket, "runtime");
  const held = await lab.index.deploymentImagePins("shop", lab.artifacts); assert.deepEqual(held.plans.find((item) => item.plan === candidate.plan)?.roles, ["unresolved"]);
  assert.deepEqual(held.plans.find((item) => item.plan === lab.initial.plan)?.roles, ["active", "last-known-good", "rollback"]); assert.equal(lab.writes(), 1);
});
