/* eslint-disable functional/no-let -- iterates bounded lifecycle reconciliation in the test */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedIndexRuntimeFixture } from "./managed-index-runtime-fixture.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { managedReleaseBaselines, parseManagedRelease } from "../../src/server/deployment/managed-release.ts";

test("indexed migration audit survives completion and a newer run without replaying an unsafe job", async (t) => {
  const lab = await managedIndexRuntimeFixture(t, true); const { source, runtime, jobs } = lab;
  await lab.index().requestManagedDeployment("shop", source, runtime);
  for (let count = 0; count < 100; count++) { const value = await lab.index().tickManagedDeployment("shop", source.run, runtime); if (value?.operation.phase === "held") break; }
  const held = await lab.index().managedState("shop", runtime); assert.equal(held?.operation.phase, "held"); assert.equal(held.operation.preparation?.sequence?.reason, "probe-unknown"); assert.equal(held.active, null);
  const heldStatus = await lab.index().managedDeploymentStatus("shop", runtime); assert.equal(heldStatus?.requiredAction, "inspect-and-resolve"); assert.equal(heldStatus.verifiedActive, null); assert.equal(heldStatus.migrations.step, "schema"); assert.equal(heldStatus.migrations.reason, "probe-unknown"); assert.equal(heldStatus.operation.deadline, held.operation.deadline);
  const assertion = { app: "shop", run: source.run, step: "schema", outcome: "applied", reason: "Fixture operator verified the application-owned migration outcome" } as const; const actor = { kind: "operator-control", identity: "index-test-operator" } as const;
  const resolved = await lab.index().resolveManagedMigration("shop", assertion, actor, runtime); assert.equal(resolved.receipt.disposition, "continue"); await lab.reopen();
  for (let count = 0; count < 100; count++) { const value = await lab.index().tickManagedDeployment("shop", source.run, runtime); if (value?.operation.phase === "complete") break; }
  const completed = await lab.index().managedState("shop", runtime); assert.equal(completed?.operation.phase, "complete"); assert.ok(completed.active); const executions = [...jobs.values()].reduce((total, value) => total + value.executions(), 0); assert.equal(executions, 2);
  const promoted = await lab.index().managedDeploymentStatus("shop", runtime); assert.equal(promoted?.verifiedActive?.run, source.run); assert.equal(promoted.runtimeObservation, "not-observed"); assert.equal(promoted.migrations.resolutions[0]?.id, resolved.receipt.resolution); assert.deepEqual(promoted.desired, promoted.requested);
  const previous = parseManagedRelease(JSON.parse(await lab.artifacts.read(completed.active.record))); const retained = managedReleaseBaselines(previous).filter((value) => previous.source.application.services[value.name]?.role === "retained-dependency").map((value) => ({ ...value, kind: "active" as const }));
  const next = parseManagedLifecycleSource({ ...source, previous, retained, run: randomUUID(), action: lab.incarnation + ":3" }); await lab.index().requestManagedDeployment("shop", next, runtime); await lab.index().cancelManagedDeployment("shop", next.run, runtime); await lab.index().tickManagedDeployment("shop", next.run, runtime); await lab.index().tickManagedDeployment("shop", next.run, runtime); await lab.reopen();
  const current = await lab.index().managedState("shop", runtime); assert.equal(current?.operation.run, next.run); assert.equal(current.operation.phase, "complete");
  const unchanged = await lab.index().managedDeploymentStatus("shop", runtime); assert.equal(unchanged?.operation.outcome, "unchanged"); assert.deepEqual(unchanged.verifiedActive, promoted.verifiedActive); assert.equal(unchanged.operation.run, next.run); assert.equal(unchanged.verifiedActive.run, source.run);
  const activeRecord = completed.active.record;
  await assert.rejects(lab.index().managedDeploymentStatus("shop", { ...runtime, read: (digest) => digest === activeRecord ? Promise.resolve("{}") : runtime.read(digest) }), /evidence is unavailable/);
  const replay = await lab.index().resolveManagedMigration("shop", assertion, actor, runtime); assert.deepEqual(replay.receipt, resolved.receipt); assert.equal(replay.state.operation.run, source.run); assert.deepEqual(await lab.index().managedState("shop", runtime), current);
  await assert.rejects(lab.index().resolveManagedMigration("shop", { ...assertion, reason: "A different assertion must not replace the recorded audit" }, actor, runtime), /conflicts/);
  lab.deny(); await assert.rejects(lab.index().resolveManagedMigration("shop", assertion, actor, runtime), /not authorized/); assert.equal([...jobs.values()].reduce((total, value) => total + value.executions(), 0), executions);
});
