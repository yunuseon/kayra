import { strict as assert } from "node:assert";
import { test } from "node:test";
import { managedIndexFixture } from "./managed-index-fixture.ts";
import { parseManagedDeploymentStatus } from "../../src/contracts/managed-deployment-status.ts";
import { managedDeploymentStatus } from "../../src/server/deployment/managed-deployment-status.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";

test("managed status is a read-only projection with original deadlines and no implicit release promotion", async (t) => {
  const lab = await managedIndexFixture(t); assert.equal(await lab.index().managedDeploymentStatus("shop", lab.runtime), null);
  await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime);
  const before = await lab.index().managedState("shop", lab.runtime); const status = await lab.index().managedDeploymentStatus("shop", lab.runtime); assert.ok(status);
  assert.equal(status.operation.phase, "admitting"); assert.equal(status.verifiedActive, null); assert.equal(status.lastKnownGood, null); assert.equal(status.rollback, "no-previous-release"); assert.equal(status.runtimeObservation, "not-observed"); assert.deepEqual(status.requested, status.desired);
  assert.deepEqual(await lab.index().managedState("shop", lab.runtime), before); assert.equal(lab.hostCalls(), 0);
  const changed = parseManagedLifecycleSource({ ...lab.source, candidate: { ...lab.plan, commit: "f".repeat(40) } });
  await assert.rejects(managedDeploymentStatus(before, changed, lab.artifacts), /source disagrees/);
  assert.equal(parseManagedDeploymentStatus({ ...status, requiredAction: "inspect-and-resolve" }).ok, false);
  assert.equal(parseManagedDeploymentStatus({ ...status, secret: "must never be published" }).ok, false);
  assert.equal(parseManagedDeploymentStatus({ ...status, operation: { ...status.operation, settled: true } }).ok, false);
  lab.clock(status.operation.deadline + 1000); await lab.reopen(); const reopened = await lab.index().managedDeploymentStatus("shop", lab.runtime); assert.deepEqual(reopened, status);
  await lab.index().cancelManagedDeployment("shop", lab.source.run, lab.runtime); await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime);
  const done = await lab.index().managedDeploymentStatus("shop", lab.runtime); assert.equal(done?.operation.outcome, "absent"); assert.equal(done.desired, null); assert.equal(done.verifiedActive, null); assert.equal(done.operation.deadline, status.operation.deadline);
});
