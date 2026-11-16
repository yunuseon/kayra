import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { managedVerificationFixture, managedRecoveryVerificationFixture } from "./managed-verification-fixture.ts";
import { managedVerificationSnapshot } from "../../src/server/deployment/managed-verification-source.ts";
import { parseManagedGroupVerification } from "../../src/server/deployment/managed-group-verification.ts";
import { parseManagedRelease, managedReleaseBaselines, managedReleaseDigest } from "../../src/server/deployment/managed-release.ts";
import { describeManagedCheck } from "../../src/server/deployment/managed-check-description.ts";
import { containerCheckDigest } from "../../src/contracts/container-check.ts";

const fixture = async (checks = false, recovery = false) => {
  const source = recovery ? await managedRecoveryVerificationFixture() : await managedVerificationFixture(checks); const snapshot = managedVerificationSnapshot(source);
  const steps = snapshot.application.rollout.checks.map((check) => {
    const witness = snapshot.witnesses.find((value) => value.name === check.service); assert.ok(witness);
    const target = { action: witness.action, service: witness.native.id, task: witness.name.padEnd(25, "t"), container: "c".repeat(64) };
    const plan = describeManagedCheck(snapshot.application, snapshot.checkRun, check.id, target, snapshot.deadline); assert.ok(plan.ok); const digest = containerCheckDigest(plan.value);
    return Object.freeze({ id: check.id, service: check.service, target, plan: digest, deadline: snapshot.deadline, execution: { version: 1, plan: digest, createdAt: 1000, deadline: snapshot.deadline, startDeadline: 91000, creates: 1, id: "e".repeat(64), executionDeadline: 3000, phase: "complete", reason: null, acknowledgedAt: 1000, runningAt: null, evidence: { exitCode: 0, at: 1000 } } });
  });
  const verification = parseManagedGroupVerification({ version: 1, source: createHash("sha256").update(JSON.stringify(snapshot.source)).digest("hex"), app: snapshot.application.infrastructure.ownership.app, incarnation: snapshot.application.infrastructure.ownership.incarnation, dataOwner: snapshot.application.infrastructure.ownership.dataOwner,
    plan: snapshot.plan, run: snapshot.run, checkRun: snapshot.checkRun, createdAt: snapshot.createdAt, deadline: snapshot.deadline, phase: "verified", reason: null, steps,
    verified: { at: 1000, observations: snapshot.witnesses.map((witness) => Object.freeze({ name: witness.name, native: { ...witness.native, version: witness.native.version + 1 }, task: witness.name.padEnd(25, "t"), routed: snapshot.application.services[witness.name]?.role === "http" ? { app: witness.action.app, incarnation: witness.action.incarnation, service: witness.name, plan: witness.action.plan, action: witness.action.action, checkedAt: 1000, status: "ready" } : null })) } });
  return { version: 1, source: snapshot.source, verification } as const;
};

test("release evidence binds complete verification and reconstructs current baselines without filename inference", async () => {
  const raw = await fixture(); const release = parseManagedRelease(raw); assert.equal(managedReleaseDigest(release).length, 64);
  const references = managedReleaseBaselines(release); assert.deepEqual(references.map((value) => value.name), ["db", "web", "worker"]); assert.ok(references.every((value) => value.native.version === 2));
  const checked = parseManagedRelease(await fixture(true)); assert.equal(checked.verification.steps[0]?.execution?.evidence?.exitCode, 0);
  const restored = parseManagedRelease(await fixture(false, true)); assert.notEqual(restored.verification.checkRun, restored.verification.run); assert.ok(managedReleaseBaselines(restored).some((value) => value.action.effect === "restore"));
});

test("ready consumers and changed source/deadlines cannot substitute for completed final verification", async () => {
  const raw = await fixture(); assert.throws(() => parseManagedRelease({ ...raw, verification: raw.source.certificate }));
  for (const verification of [{ ...raw.verification, source: "a".repeat(64) }, { ...raw.verification, deadline: raw.verification.deadline + 1 }, { ...raw.verification, phase: "running", verified: null }]) assert.throws(() => parseManagedRelease({ ...raw, verification }));
});

test("missing or changed native identities and stale routed readiness cannot become release records", async () => {
  const raw = await fixture(); const verified = raw.verification.verified; assert.ok(verified);
  for (const observations of [verified.observations.slice(1), verified.observations.map((value, index) => index === 0 ? { ...value, native: { ...value.native, id: "x".repeat(25) } } : value), verified.observations.map((value) => value.routed === null ? value : { ...value, routed: { ...value.routed, status: "unready" } })]) assert.throws(() => parseManagedRelease({ ...raw, verification: { ...raw.verification, verified: { ...verified, observations } } }));
});

test("forged check commands, targets and ambiguous starts cannot be promoted through a successful-looking certificate", async () => {
  const raw = await fixture(true); const step = raw.verification.steps[0]; assert.ok(step?.execution && step.target);
  for (const change of [
    { ...step, plan: "f".repeat(64), execution: { ...step.execution, plan: "f".repeat(64) } },
    { ...step, target: { ...step.target, action: { ...step.target.action, action: step.target.action.incarnation + ":1" } } },
    { ...step, execution: { ...step.execution, acknowledgedAt: null, runningAt: null } },
  ]) assert.throws(() => parseManagedRelease({ ...raw, verification: { ...raw.verification, steps: [change] } }));
});
