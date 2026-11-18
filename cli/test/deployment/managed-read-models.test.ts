/* eslint-disable functional/no-let -- drives bounded runtime reconciliation in the fixture */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { managedIndexFixture } from "./managed-index-fixture.ts";
import { managedIndexRuntimeFixture } from "./managed-index-runtime-fixture.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { openLifecycleEnvelopeStore } from "../../src/server/deployment/lifecycle-envelope-store.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { managedReleaseBaselines, parseManagedRelease } from "../../src/server/deployment/managed-release.ts";

const appDirectory = (directory: string) => join(directory, createHash("sha256").update("shop").digest("hex"));
const observer = (metadata: { readonly app: string; readonly incarnation: string; readonly actionId: string; readonly registrationGeneration: string }) => Promise.resolve({ ...metadata, status: "applied" });

test("published managed reports require only read capabilities and never initialize an empty deployment journal", async (t) => {
  const lab = await managedIndexFixture(t); const ports = { read: lab.artifacts.read, now: lab.runtime.now }; const health = { ...ports, services: { observe: lab.runtime.services.observe, observeDesired: lab.runtime.services.observeDesired } };
  const path = join(appDirectory(lab.directory), "managed"); const before = await readdir(path);
  assert.equal(await lab.index().managedDeploymentStatus("shop", ports), null); assert.equal(await lab.index().managedDeploymentImagePins("shop", ports), null); assert.equal(await lab.index().managedDeploymentHealth("shop", health), null);
  assert.deepEqual(await readdir(path), before); assert.equal(lab.hostCalls(), 0);
  await lab.artifacts.retain(JSON.stringify(lab.source)); await lab.index().close(); const journal = await openJournal(appDirectory(lab.directory), "existing");
  try { await openLifecycleEnvelopeStore(journal, observer).prepareManaged(lab.source, 1000); } finally { await journal.close(); } await lab.reopen();
  await assert.rejects(lab.index().managedDeploymentStatus("shop", ports), /missing/); await assert.rejects(lab.index().managedDeploymentImagePins("shop", ports), /missing/); await assert.rejects(lab.index().managedDeploymentHealth("shop", health), /missing/);
  assert.deepEqual(await readdir(path), before); assert.deepEqual(await lab.index().pendingManagedDeployments(), [{ app: "shop", run: lab.source.run }]);
  await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); assert.equal((await lab.index().managedDeploymentStatus("shop", ports))?.operation.run, lab.source.run);
});

test("reporting refuses stale root state after request acceptance and leaves reconstruction to the lifecycle owner", async (t) => {
  const lab = await managedIndexRuntimeFixture(t); await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime);
  for (let count = 0; count < 100; count++) { const state = await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); if (state?.operation.phase === "complete") break; }
  const current = await lab.index().managedState("shop", lab.runtime); assert.ok(current?.active);
  const previous = parseManagedRelease(JSON.parse(await lab.artifacts.read(current.active.record))); const retained = managedReleaseBaselines(previous).filter((value) => previous.source.application.services[value.name]?.role === "retained-dependency").map((value) => ({ ...value, kind: "active" as const }));
  const next = parseManagedLifecycleSource({ ...lab.source, previous, retained, run: randomUUID(), action: lab.incarnation + ":3" }); await lab.artifacts.retain(JSON.stringify(next));
  await lab.index().close(); const journal = await openJournal(appDirectory(lab.directory), "existing"); try { await openLifecycleEnvelopeStore(journal, observer).prepareManaged(next, 1000); } finally { await journal.close(); } await lab.reopen();
  const ports = { read: lab.artifacts.read, now: lab.runtime.now }; const health = { ...ports, services: { observe: lab.runtime.services.observe, observeDesired: lab.runtime.services.observeDesired } };
  await assert.rejects(lab.index().managedDeploymentStatus("shop", ports), /awaiting lifecycle reconciliation/); await assert.rejects(lab.index().managedDeploymentImagePins("shop", ports), /awaiting lifecycle reconciliation/); await assert.rejects(lab.index().managedDeploymentHealth("shop", health), /awaiting lifecycle reconciliation/);
  await lab.index().tickManagedDeployment("shop", next.run, lab.runtime);
  const rebuilt = await lab.index().managedDeploymentStatus("shop", ports); assert.equal(rebuilt?.operation.run, next.run); assert.equal(rebuilt.verifiedActive?.run, lab.source.run); assert.equal((await lab.index().managedDeploymentHealth("shop", health))?.state, "available"); assert.equal((await lab.index().managedDeploymentImagePins("shop", ports))?.gcSafe, false);
});
