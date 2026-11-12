import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseDeploymentStatus } from "../../src/contracts/deployment-status.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { createLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { fixture, commit } from "./http-test-fixture.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("published status separates the requested candidate from certified active state without journal internals", async (t) => {
  const { index, ports, builds } = await fixture(t);
  const initial = await index.deploymentStatus("shop");
  assert.equal(initial.runtime, "swarm"); assert.equal(initial.verification, "unverified");
  assert.equal(initial.verifiedActive, null); assert.equal(initial.operation, null);
  assert.equal(initial.runtimeObservation, "not-observed");
  await index.prepareBuild("shop", commit, builds);
  const request = await index.prepareHttpRollout("shop", randomUUID(), commit, ports);
  const prepared = await index.deploymentStatus("shop");
  assert.deepEqual(prepared.requested, { plan: request.plan, commit });
  assert.deepEqual(prepared.desired, prepared.requested);
  assert.equal(prepared.verifiedActive, null);
  assert.equal(prepared.operation?.phase, "prepared");
  assert.equal(prepared.operation.updateDeadline, request.deadline);
  const json = JSON.stringify(prepared);
  for (const field of ["ticket", "steps", "expected", "configurationIdentity", "TOKEN", "environment", "native"]) assert.equal(json.includes('"' + field + '"'), false);
  assert.ok(Object.isFrozen(prepared)); assert.ok(Object.isFrozen(prepared.requested)); assert.ok(Object.isFrozen(prepared.operation));
  assert.equal(parseDeploymentStatus({ ...prepared, privateJournal: {} }).ok, false);
  assert.equal(parseDeploymentStatus({ ...prepared, requiredAction: "inspect-and-resolve" }).ok, false);
});

test("held operations publish the required action but leave their capacity charged and out of automatic work", async (t) => {
  const { index, ports, builds } = await fixture(t);
  await index.prepareBuild("shop", commit, builds);
  const request = await index.prepareHttpRollout("shop", randomUUID(), commit, ports);
  await index.admitHttpRollout("shop", request.ticket, ports);
  await index.recordHttpNativeIntent("shop", request.ticket, { effect: "apply", attempt: 1, plan: request.plan, expected: null, deadline: request.deadline });
  await index.beginHttpRecovery("shop", request.ticket, "deadline", request.deadline + 1);
  await index.holdHttp("shop", request.ticket, "deadline");
  const held = await index.deploymentStatus("shop");
  assert.equal(held.operation?.phase, "held"); assert.equal(held.requiredAction, "inspect-and-resolve");
  assert.equal(held.operation.recoveryDeadline, request.deadline + 90_000);
  assert.equal(held.verifiedActive, null);
  assert.deepEqual(await index.pendingHttpOperations(), []);
  assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "pending");
});

test("restart lists durable work and unsettled terminal accounting without inventing new requests", async (t) => {
  const { path, index, ports, builds } = await fixture(t);
  await index.prepareBuild("shop", commit, builds);
  const request = await index.prepareHttpRollout("shop", randomUUID(), commit, ports);
  await index.admitHttpRollout("shop", request.ticket, ports);
  const expected = [{ app: "shop", request: request.request }];
  assert.deepEqual(await index.pendingHttpOperations(), expected);
  await index.close(); const recovered = await openLifecycleAppIndex(path); t.after(() => recovered.close());
  assert.deepEqual(await recovered.pendingHttpOperations(), expected);
  await recovered.finishHttpUnstarted("shop", request.ticket, "deadline");
  const failed = await recovered.deploymentStatus("shop");
  assert.equal(failed.operation?.phase, "failed"); assert.equal(failed.operation.recovery, "unstarted");
  assert.equal(failed.requested?.plan, request.plan); assert.equal(failed.desired, null);
  assert.deepEqual(await recovered.pendingHttpOperations(), expected);
  await recovered.reconcileHttpResources("shop", request.ticket);
  assert.deepEqual(await recovered.pendingHttpOperations(), []);
  await recovered.close(); await assert.rejects(recovered.pendingHttpOperations(), /closed/);
});

test("indexed Compose status remains explicitly legacy and never infers an active release", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "kayra-status-")); t.after(() => rm(path, { recursive: true, force: true }));
  const index = await createLifecycleAppIndex(join(path, "index"), (identity) => Promise.resolve({ ...identity, status: "applied" })); t.after(() => index.close());
  await index.prepareApp("legacy"); const generation = randomUUID();
  const ticket = await index.reserveRegistration("legacy", generation);
  await index.submitRegistration("legacy", ticket, generation); await index.reconcileRegistration("legacy", ticket, generation);
  const status = await index.deploymentStatus("legacy");
  assert.equal(status.runtime, "compose"); assert.equal(status.verification, "legacy-unverified");
  assert.equal(status.verifiedActive, null); assert.equal(status.lastKnownGood, null);
  assert.equal(status.operation, null); assert.deepEqual(await index.pendingHttpOperations(), []);
  assert.equal(parseDeploymentStatus({ ...status, verification: "verified" }).ok, false);
});

test("one unavailable application does not prevent another application's restart reconciliation", async () => {
  const { reconcileHttpWork } = await import("../../src/server/deployment/http-work.ts");
  const a = { app: "first", request: randomUUID() }; const b = { app: "second", request: randomUUID() };
  const result = await reconcileHttpWork({ pendingHttpOperations: () => Promise.resolve([a, b]) }, {
    tick: (app) => app === a.app ? Promise.reject(new Error("private port response")) : Promise.resolve("recovering"),
  });
  assert.deepEqual(result, [{ ...a, outcome: "unavailable" }, { ...b, outcome: "recovering" }]);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result[0]));
  await assert.rejects(reconcileHttpWork({ pendingHttpOperations: () => Promise.reject(new Error("index corrupt")) }, {
    tick: () => { throw new Error("a corrupt index must not dispatch work"); },
  }), /index corrupt/);
});

test("a failed candidate remains requested while the restored release is desired and certified active", async (t) => {
  const { index, ports, builds } = await fixture(t);
  await index.prepareBuild("shop", commit, builds);
  const a = await index.prepareHttpRollout("shop", randomUUID(), commit, ports);
  await index.admitHttpRollout("shop", a.ticket, ports);
  await index.recordHttpNativeIntent("shop", a.ticket, { effect: "apply", attempt: 1, expected: null, deadline: a.deadline, plan: a.plan });
  const incarnation = a.action.split(":")[0] ?? "";
  const observed = { status: "owned" as const, id: "s".repeat(25), version: 42, action: a.action, effect: "apply" as const, plan: a.plan,
    taskPlan: a.plan, taskEffect: "apply" as const, specMatches: true, tombstone: false, retainedInputsCleared: false, replicas: 1, endpoint: "vip" as const, update: "completed",
    tasks: [{ id: "t".repeat(25), incarnation, action: a.action, effect: "apply" as const, plan: a.plan, desired: "running", state: "running", health: "healthy" as const }] };
  const routed = { app: "shop", incarnation, service: a.service, action: a.action, plan: a.plan, checkedAt: 2000, status: "ready" as const };
  await index.promoteHttpRollout("shop", a.ticket, observed, routed, 2000);
  await index.prepareBuild("shop", "b".repeat(40), builds);
  const b = await index.prepareHttpRollout("shop", randomUUID(), "b".repeat(40), ports);
  const applying = await index.deploymentStatus("shop");
  assert.equal(applying.requested?.commit, b.commit); assert.equal(applying.desired?.plan, b.plan);
  assert.equal(applying.verifiedActive?.plan, a.plan); assert.equal(applying.lastKnownGood?.plan, a.plan);
  assert.equal(applying.runtimeObservation, "not-observed");
  await index.admitHttpRollout("shop", b.ticket, ports);
  await index.recordHttpNativeIntent("shop", b.ticket, { effect: "apply", attempt: 1, expected: { id: observed.id, version: observed.version }, deadline: b.deadline, plan: b.plan });
  await index.beginHttpRecovery("shop", b.ticket, "runtime", 2001);
  await index.finishHttpRecovery("shop", b.ticket, "automatic-rollback", { ...observed, action: b.action, plan: b.plan, version: 44, update: "rollback_completed" }, { ...routed, checkedAt: 2001 }, 2001);
  const restored = await index.deploymentStatus("shop");
  assert.deepEqual(restored.requested, { plan: b.plan, commit: b.commit });
  assert.deepEqual(restored.desired, { plan: a.plan, commit: a.commit });
  assert.deepEqual(restored.verifiedActive, { plan: a.plan, commit: a.commit, verifiedAt: 2001 });
  assert.deepEqual(restored.lastKnownGood, restored.verifiedActive);
  assert.equal(restored.operation?.phase, "failed"); assert.equal(restored.operation.recovery, "automatic-rollback");
  assert.equal(restored.requiredAction, "none");
  assert.equal(parseDeploymentStatus({ ...restored, verification: "unverified" }).ok, false);
});

test("the reporting contract preserves legacy Compose app-name compatibility", () => {
  const parsed = parseDeploymentStatus({ version: 1, app: "legacy-" + "a".repeat(300), incarnation: randomUUID(), runtime: "compose", lifecycle: "registered",
    verification: "legacy-unverified", requested: null, desired: null, verifiedActive: null, lastKnownGood: null, operation: null, requiredAction: "none", runtimeObservation: "not-observed" });
  assert.ok(parsed.ok);
});
