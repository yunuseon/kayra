/* eslint-disable functional/no-let -- iterates bounded lifecycle reconciliation in the test */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { managedIndexRuntimeFixture } from "./managed-index-runtime-fixture.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { managedReleaseBaselines, parseManagedRelease } from "../../src/server/deployment/managed-release.ts";
import { managedOperationControl } from "../../src/server/deployment/managed-operation-control.ts";
import { deploymentControl } from "../../src/server/deployment/deployment-control.ts";

test("indexed migration audit survives completion and a newer run without replaying an unsafe job", async (t) => {
  const lab = await managedIndexRuntimeFixture(t, true); const { source, runtime, jobs } = lab;
  await lab.index().requestManagedDeployment("shop", source, runtime);
  for (let count = 0; count < 100; count++) { const value = await lab.index().tickManagedDeployment("shop", source.run, runtime); if (value?.operation.phase === "held") break; }
  const held = await lab.index().managedState("shop", runtime); assert.equal(held?.operation.phase, "held"); assert.equal(held.operation.preparation?.sequence?.reason, "probe-unknown"); assert.equal(held.active, null);
  const heldStatus = await lab.index().managedDeploymentStatus("shop", runtime); assert.equal(heldStatus?.requiredAction, "inspect-and-resolve"); assert.equal(heldStatus.verifiedActive, null); assert.equal(heldStatus.migrations.step, "schema"); assert.equal(heldStatus.migrations.reason, "probe-unknown"); assert.equal(heldStatus.operation.deadline, held.operation.deadline);
  const assertion = { app: "shop", run: source.run, step: "schema", outcome: "applied", reason: "Fixture operator verified the application-owned migration outcome" } as const; const actor = { kind: "operator-control", identity: "index-test-operator" } as const;
  const control = (mutations = true) => {
    const commands = managedOperationControl(lab.index(), { read: runtime.read, now: runtime.now, actor, canAccess: (app) => Promise.resolve(app === "shop"), prepare: () => Promise.reject(new Error("unexpected preparation")), forRun: () => mutations ? Promise.resolve(runtime) : Promise.reject(new Error("audit cannot load native ports")) });
    return deploymentControl({ index: lab.index(), now: runtime.now, enabled: () => Promise.resolve(false), canAccess: (app) => Promise.resolve(app === "shop"), managedAudit: commands.audit, managed: mutations ? commands : undefined });
  };
  const query = { app: "shop", run: source.run, step: "schema" };
  assert.deepEqual(await control(false)("/deployment/migration-audit", query), { version: 1, ...query, audit: null });
  assert.deepEqual(await lab.index().managedState("shop", runtime), held);
  await assert.rejects(control(false)("/deployment/migration-resolve", assertion), /mutation dispatch is disabled/);
  const decision = await control()("/deployment/migration-resolve", assertion); const resolved = await lab.index().resolveManagedMigration("shop", assertion, actor, runtime); assert.deepEqual(decision, resolved.receipt); assert.equal(resolved.receipt.disposition, "continue");
  const audit = await control(false)("/deployment/migration-audit", query); assert.deepEqual(audit, { version: 1, ...query, audit: (await lab.index().managedState("shop", runtime))?.operation.preparation?.sequence?.steps[0]?.resolution }); await lab.reopen();
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
  assert.deepEqual(await control()("/deployment/migration-resolve", assertion), decision); assert.deepEqual(await control(false)("/deployment/migration-audit", query), audit);
  const root = join(lab.directory, createHash("sha256").update("shop").digest("hex"), "managed", "state.json"); await rename(root, root + ".kept");
  try { assert.deepEqual(await control(false)("/deployment/migration-audit", query), audit); await assert.rejects(stat(root), { code: "ENOENT" }); } finally { await rename(root + ".kept", root); }
  await assert.rejects(control(false)("/deployment/migration-audit", { ...query, app: "other" }), /outside deployment scope/);
  await assert.rejects(lab.index().resolveManagedMigration("shop", { ...assertion, reason: "A different assertion must not replace the recorded audit" }, actor, runtime), /conflicts/);
  lab.deny(); await assert.rejects(lab.index().resolveManagedMigration("shop", assertion, actor, runtime), /not authorized/); assert.equal([...jobs.values()].reduce((total, value) => total + value.executions(), 0), executions);
});

test("unresolved migration audit reads require the existing root and never repair missing or corrupt evidence", async (t) => {
  const lab = await managedIndexRuntimeFixture(t); await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime);
  const root = join(lab.directory, createHash("sha256").update("shop").digest("hex"), "managed", "state.json"); const before = await readFile(root, "utf8");
  assert.equal(await lab.index().managedMigrationAudit("shop", lab.source.run, "schema", lab.runtime), null); assert.equal(await readFile(root, "utf8"), before);
  await assert.rejects(lab.index().managedMigrationAudit("shop", lab.source.run, "schema", { ...lab.runtime, read: () => Promise.resolve("{}") }), /audit evidence unavailable/);
  await rename(root, root + ".kept");
  try { await assert.rejects(lab.index().managedMigrationAudit("shop", lab.source.run, "schema", lab.runtime)); await assert.rejects(stat(root), { code: "ENOENT" }); } finally { await rename(root + ".kept", root); }
  assert.equal(await readFile(root, "utf8"), before); assert.equal(lab.hostCalls(), 0); assert.equal(lab.jobs.size, 0);
});

test("migration actor identity cannot be supplied by command payloads or omitted from the trusted transport", async (t) => {
  const lab = await managedIndexRuntimeFixture(t); const commands = managedOperationControl(lab.index(), { read: lab.runtime.read, now: lab.runtime.now, canAccess: () => Promise.reject(new Error("unexpected scope read")), prepare: () => Promise.reject(new Error("unexpected preparation")), forRun: () => Promise.reject(new Error("unexpected runtime composition")) });
  const request = { app: "shop", run: lab.source.run, step: "schema", outcome: "applied", reason: "Fixture decision requires a trusted operator identity" };
  await assert.rejects(commands.resolve(request), /operator identity/); await assert.rejects(commands.resolve({ ...request, actor: { kind: "operator-control", identity: "untrusted-payload" } }), /invalid managed migration/);
  assert.deepEqual(await lab.index().pendingManagedDeployments(), []); assert.equal(lab.jobs.size, 0);
});
