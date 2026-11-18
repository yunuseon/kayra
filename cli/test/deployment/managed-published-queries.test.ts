/* eslint-disable functional/no-let -- drives the bounded fixture rollout */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { managedIndexRuntimeFixture } from "./managed-index-runtime-fixture.ts";
import { deploymentControl } from "../../src/server/deployment/deployment-control.ts";
import { schemas } from "../../src/clients/wire/schemas.ts";

test("existing authenticated queries publish managed reports while mutation dispatch remains disabled", async (t) => {
  const lab = await managedIndexRuntimeFixture(t); const readers = { read: lab.artifacts.read, now: lab.runtime.now };
  const control = () => deploymentControl({ index: lab.index(), now: readers.now, artifacts: readers, managedObservations: { ...readers, services: { observe: lab.runtime.services.observe, observeDesired: lab.runtime.services.observeDesired } }, canAccess: (app) => Promise.resolve(app === "shop"), enabled: () => Promise.resolve(false) });
  assert.equal(await control()("/deployment/status", { app: "shop" }), null); assert.equal(await control()("/deployment/pins", { app: "shop" }), null); assert.equal(await control()("/deployment/health", { app: "shop" }), null);
  for (const path of ["/deployment/status", "/deployment/pins", "/deployment/health"]) await assert.rejects(control()(path, { app: "other" }), /outside deployment scope/);
  await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime);
  for (let count = 0; count < 100; count++) { const state = await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); if (state?.operation.phase === "complete") break; }
  const before = await lab.index().managedState("shop", lab.runtime);
  const status = schemas.DeploymentStatus.parse(await control()("/deployment/status", { app: "shop" })); assert.equal(status?.version, 3); assert.equal(status.operation.run, lab.source.run); assert.equal(status.verifiedActive?.run, lab.source.run);
  const pins = schemas.DeploymentImagePins.parse(await control()("/deployment/pins", { app: "shop" })); assert.equal(pins?.version, 3); assert.equal(pins.gcSafe, false);
  assert.equal(schemas.DeploymentHealth.parse(await control()("/deployment/health", { app: "shop" }))?.state, "available"); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), before);
  const legacyObservations = { ...readers, observe: () => Promise.reject(new Error("legacy observations must not handle managed services")) };
  const withoutManaged = deploymentControl({ index: lab.index(), now: readers.now, artifacts: readers, observations: legacyObservations, canAccess: () => Promise.resolve(true), enabled: () => Promise.resolve(false) });
  await assert.rejects(withoutManaged("/deployment/health", { app: "shop" }), /managed-v3 runtime health observations/);
  await assert.rejects(control()("/deployment/cancel", { app: "shop", request: lab.source.run }), /legacy deployment commands/);
  assert.equal(await control()("/deployment/status", { app: "shop", runtime: "compose" }), undefined);
  await lab.reopen(); assert.deepEqual(await control()("/deployment/status", { app: "shop" }), status);
});
