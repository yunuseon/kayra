/* eslint-disable functional/no-let -- drives bounded reconciliation in the fixture */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedIndexRuntimeFixture } from "./managed-index-runtime-fixture.ts";
import { parseManagedImagePins } from "../../src/contracts/managed-image-pins.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { managedReleaseBaselines, parseManagedRelease } from "../../src/server/deployment/managed-release.ts";

test("managed pins retain certified, candidate, rollback and unresolved image/bundle identities without GC authority", async (t) => {
  const lab = await managedIndexRuntimeFixture(t); const { source, runtime } = lab;
  assert.equal(await lab.index().managedDeploymentImagePins("shop", runtime), null);
  await lab.index().requestManagedDeployment("shop", source, runtime);
  const pending = await lab.index().managedDeploymentImagePins("shop", runtime); assert.ok(pending); assert.equal(pending.gcSafe, false); assert.equal(pending.attachments, "not-observed"); assert.deepEqual(pending.plans[0]?.roles, ["candidate", "unresolved"]); assert.equal(pending.plans[0].bundle, source.candidate.artifact);
  for (let count = 0; count < 100; count++) { const state = await lab.index().tickManagedDeployment("shop", source.run, runtime); if (state?.operation.phase === "complete") break; }
  const deployed = await lab.index().managedState("shop", runtime); assert.ok(deployed?.active); const activePlan = deployed.active.plan; const first = await lab.index().managedDeploymentImagePins("shop", runtime); assert.ok(first); assert.deepEqual(first.plans[0]?.roles, ["active", "candidate", "last-known-good"]);
  const previous = parseManagedRelease(JSON.parse(await lab.artifacts.read(deployed.active.record))); const retained = managedReleaseBaselines(previous).filter((value) => previous.source.application.services[value.name]?.role === "retained-dependency").map((value) => ({ ...value, kind: "active" as const }));
  const worker = source.candidate.services["worker"]; assert.ok(worker);
  const next = parseManagedLifecycleSource({ ...source, previous, retained, run: randomUUID(), action: lab.incarnation + ":3", candidate: { ...source.candidate, services: { ...source.candidate.services, worker: { ...worker, inputs: { ...worker.inputs, environment: { PRIVATE_LITERAL: { kind: "literal", value: "must-not-appear-in-pins" } } } } } } });
  await lab.index().requestManagedDeployment("shop", next, runtime);
  const state = await lab.index().managedState("shop", runtime); const overlap = await lab.index().managedDeploymentImagePins("shop", runtime); assert.ok(overlap); assert.equal(overlap.plans.length, 2); assert.deepEqual(overlap.plans.find((plan) => plan.plan === activePlan)?.roles, ["active", "last-known-good", "rollback"]); assert.equal(overlap.plans.some((plan) => plan.roles.includes("unresolved")), true);
  assert.equal(JSON.stringify(overlap).includes("must-not-appear-in-pins"), false); assert.equal(JSON.stringify(overlap).includes("TOKEN"), false); assert.deepEqual(await lab.index().managedState("shop", runtime), state);
  assert.equal(parseManagedImagePins({ ...overlap, gcSafe: true }).ok, false); const pin = overlap.plans[0]; assert.ok(pin);
  assert.equal(parseManagedImagePins({ ...overlap, plans: [{ ...pin, images: ["localhost:5000/other/image@sha256:" + "a".repeat(64)] }] }).ok, false);
  assert.equal(parseManagedImagePins({ ...overlap, plans: [{ ...pin, roles: ["active", "active"] }] }).ok, false);
  await lab.index().cancelManagedDeployment("shop", next.run, runtime); await lab.index().tickManagedDeployment("shop", next.run, runtime); await lab.index().tickManagedDeployment("shop", next.run, runtime);
  const done = await lab.index().managedDeploymentImagePins("shop", runtime); assert.ok(done); assert.equal(done.plans.length, 2); assert.equal(done.plans.some((plan) => plan.roles.includes("unresolved")), false); await lab.reopen(); assert.deepEqual(await lab.index().managedDeploymentImagePins("shop", runtime), done);
  const record = deployed.active.record; await assert.rejects(lab.index().managedDeploymentImagePins("shop", { ...runtime, read: (digest) => digest === record ? Promise.resolve("{}") : runtime.read(digest) }), /evidence is unavailable/);
});

test("an ambiguous migration pins its candidate as unresolved without inventing an active release", async (t) => {
  const lab = await managedIndexRuntimeFixture(t, true); await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime);
  for (let count = 0; count < 100; count++) { const state = await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); if (state?.operation.phase === "held") break; }
  const pins = await lab.index().managedDeploymentImagePins("shop", lab.runtime); assert.ok(pins); assert.deepEqual(pins.plans[0]?.roles, ["candidate", "unresolved"]); assert.equal((await lab.index().managedState("shop", lab.runtime))?.active, null);
});
