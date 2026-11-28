import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import { managedRecoveryVerificationFixture, managedVerificationFixture as fixture } from "./managed-verification-fixture.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { managedVerificationSnapshot, recoveryCheckRun } from "../../src/server/deployment/managed-verification-source.ts";


test("verification snapshots all admitted workloads and derives its fixed window from convergence", async () => {
  const input = await fixture(true); const snapshot = managedVerificationSnapshot(input);
  assert.deepEqual(snapshot.witnesses.map((item) => item.name), ["db", "web", "worker"]); assert.equal(snapshot.createdAt, input.certificate.verifiedAt); assert.equal(snapshot.deadline, 93000); assert.equal(snapshot.checkRun, input.certificate.run);
  assert.deepEqual(managedVerificationSnapshot(JSON.parse(JSON.stringify(snapshot.source))), snapshot);
  const noChecks = managedVerificationSnapshot(await fixture()); assert.equal(noChecks.deadline, noChecks.createdAt + 90000);
});

test("missing retained, routed or current-plan evidence cannot authorize verification", async () => {
  const input = await fixture(); assert.throws(() => managedVerificationSnapshot({ ...input, certificate: { ...input.certificate, retained: [] } }), /service set/);
  const unrouted = { ...input.certificate, nodes: input.certificate.nodes.map((node) => ({ ...node, ready: node.ready?.kind === "running" ? { ...node.ready, routed: null } : node.ready })) };
  assert.throws(() => managedVerificationSnapshot({ ...input, certificate: unrouted }), /HTTP evidence/);
  assert.throws(() => managedVerificationSnapshot({ ...input, application: { ...input.application, commit: "f".repeat(40) } }), /ready consumers/);
});

test("rollback check identities remain stable and distinct from candidate and other releases", () => {
  const run = randomUUID(); const application = "a".repeat(64); const identity = recoveryCheckRun(run, application); assert.ok(z.uuid().safeParse(identity).success); assert.notEqual(identity, run); assert.equal(recoveryCheckRun(run, application), identity); assert.notEqual(recoveryCheckRun(run, "b".repeat(64)), identity);
});

test("oversized check lists fail plan validation before workload mutation", async () => {
  const input = await fixture(); const checks = Array.from({ length: 129 }, (_, index) => ({ id: `check-${String(index)}`, service: "web", command: ["/check"], timeout_seconds: 1 }));
  assert.equal(parseManagedApplicationPlan({ ...input.application, rollout: { ...input.application.rollout, checks } }).ok, false);
});

test("recovery verification binds the previous plan, full recovery input and restored/retained native witnesses", async () => {
  const input = await managedRecoveryVerificationFixture(); const snapshot = managedVerificationSnapshot(input);
  assert.equal(snapshot.plan, input.certificate.previous); assert.notEqual(snapshot.checkRun, input.certificate.run); assert.equal(snapshot.checkRun, recoveryCheckRun(input.certificate.run, snapshot.plan));
  assert.deepEqual(snapshot.witnesses.map((item) => item.action.effect), ["apply", "restore", "restore"]);
  assert.throws(() => managedVerificationSnapshot({ ...input, certificate: { ...input.certificate, source: "f".repeat(64) } }), /recovery evidence/);
  assert.deepEqual(managedVerificationSnapshot(JSON.parse(JSON.stringify(snapshot.source))), snapshot);
});
