import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Result } from "../../src/lib/result.ts";
import { initialReleaseState, observeRelease, promoteRelease, requestRelease, requestRollback, type ReleaseIdentity, type ReleaseObservation, type RolloutRequirements } from "../../src/server/deployment/release-state.ts";

const must = <T>(result: Result<T, string>) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const releaseA: ReleaseIdentity = { commit: "a".repeat(40), planDigest: "1".repeat(64) };
const releaseB: ReleaseIdentity = { commit: "b".repeat(40), planDigest: "2".repeat(64) };
const opA = "11111111-1111-4111-8111-111111111111";
const opB = "22222222-2222-4222-8222-222222222222";
const opC = "33333333-3333-4333-8333-333333333333";
const aRequirements: RolloutRequirements = { rollbackCompatible: true, requiredHandoffs: ["handoff-a"] };
const bRequirements: RolloutRequirements = { rollbackCompatible: true, requiredHandoffs: ["handoff-b"] };
const good = (release: ReleaseIdentity, completedHandoffs: readonly string[], operationId = release === releaseA ? opA : opB): ReleaseObservation => ({ operationId, release, convergence: "passed", routedReadiness: "passed", completedHandoffs, outcomes: "clear" });
const activeA = () => must(promoteRelease(must(observeRelease(must(requestRelease(initialReleaseState([]), releaseA, aRequirements, opA)), good(releaseA, ["handoff-a"], opA)) )));

test("legacy history stays readable without claiming an active or rollback release", () => {
  const state = initialReleaseState(["20261029T010000Z-" + "b".repeat(40) + ".env"]);
  assert.equal(state.legacyHistory.length, 1);
  assert.equal(state.verifiedActive, undefined);
  assert.equal(state.lastKnownGood, undefined);
  assert.equal(state.rollbackTarget, undefined);
  assert.equal(requestRollback(state, { operationId: opB, release: releaseB, outcomes: "clear" }, opC).ok, false);
});

test("request, desired, observed and active releases remain distinct until verification", () => {
  const before = activeA();
  const candidate = must(requestRelease(before, releaseB, bRequirements, opB));
  assert.deepEqual(candidate.requested, releaseB);
  assert.deepEqual(candidate.desired, releaseB);
  assert.deepEqual(candidate.verifiedActive, releaseA);
  assert.deepEqual(candidate.lastKnownGood, releaseA);
  assert.deepEqual(candidate.rollbackTarget, releaseA);
  assert.equal(candidate.observed, undefined);
  assert.equal(promoteRelease(candidate).ok, false);
  assert.equal(observeRelease(candidate, good(releaseA, ["handoff-b"])).ok, false);
  assert.equal(requestRelease(candidate, releaseB, bRequirements, opB).ok, false);
  const success = must(promoteRelease(must(observeRelease(candidate, good(releaseB, ["handoff-b"])) )));
  assert.deepEqual(success.verifiedActive, releaseB);
  assert.deepEqual(success.lastKnownGood, releaseB);
  assert.deepEqual(success.rollbackTarget, releaseA);
});

test("promotion requires convergence, routed readiness, all handoffs and resolved outcomes", () => {
  const candidate = must(requestRelease(activeA(), releaseB, bRequirements, opB));
  const complete = good(releaseB, ["handoff-b"]);
  for (const partial of [
    { ...complete, convergence: "unknown" as const },
    { ...complete, convergence: "failed" as const },
    { ...complete, routedReadiness: "unknown" as const },
    { ...complete, routedReadiness: "failed" as const },
    { ...complete, outcomes: "unknown" as const },
    { ...complete, outcomes: "unresolved" as const },
    { ...complete, completedHandoffs: [] },
  ]) assert.equal(promoteRelease(must(observeRelease(candidate, partial))).ok, false);
  assert.equal(observeRelease(candidate, { ...complete, completedHandoffs: ["other"] }).ok, false);
  assert.equal(observeRelease(candidate, { ...complete, completedHandoffs: ["handoff-b", "handoff-b"] }).ok, false);
  assert.equal(promoteRelease(must(observeRelease(candidate, complete))).ok, true);
});

test("rollback requires compatible declaration and resolved effects, then verifies the target's own checks", () => {
  const prior = activeA();
  const incompatible = must(requestRelease(prior, releaseB, { ...bRequirements, rollbackCompatible: false }, opB));
  assert.equal(requestRollback(must(observeRelease(incompatible, good(releaseB, ["handoff-b"]))), { operationId: opB, release: releaseB, outcomes: "clear" }, opC).ok, false);
  const candidate = must(requestRelease(prior, releaseB, bRequirements, opB));
  assert.equal(requestRollback(candidate, { operationId: opB, release: releaseB, outcomes: "clear" }, opC).ok, false);
  assert.equal(requestRollback(must(observeRelease(candidate, { ...good(releaseB, []), outcomes: "unresolved" })), { operationId: opB, release: releaseB, outcomes: "clear" }, opC).ok, false);
  const promoted = must(promoteRelease(must(observeRelease(candidate, good(releaseB, ["handoff-b"])) )));
  assert.equal(requestRollback(promoted, { operationId: opB, release: releaseB, outcomes: "unresolved" }, opC).ok, false);
  assert.equal(requestRollback(promoted, { operationId: opB, release: releaseA, outcomes: "clear" }, opC).ok, false);
  const rollingBack = must(requestRollback(promoted, { operationId: opB, release: releaseB, outcomes: "clear" }, opC));
  assert.deepEqual(rollingBack.requested, releaseB);
  assert.deepEqual(rollingBack.desired, releaseA);
  assert.deepEqual(rollingBack.verifiedActive, releaseB);
  assert.deepEqual(rollingBack.requirements?.requiredHandoffs, ["handoff-a"]);
  assert.equal(promoteRelease(rollingBack).ok, false);
  assert.equal(observeRelease(rollingBack, good(releaseB, ["handoff-b"])).ok, false);
  assert.equal(promoteRelease(must(observeRelease(rollingBack, good(releaseA, [], opC)))).ok, false);
  const restored = must(promoteRelease(must(observeRelease(rollingBack, good(releaseA, ["handoff-a"], opC)) )));
  assert.deepEqual(restored.verifiedActive, releaseA);
  assert.deepEqual(restored.lastKnownGood, releaseA);
  assert.equal(restored.rollbackTarget, undefined);
});

test("evidence from an earlier operation cannot promote the same immutable plan again", () => {
  const prior = activeA();
  const repeated = must(requestRelease(prior, releaseA, aRequirements, opB));
  assert.equal(observeRelease(repeated, good(releaseA, ["handoff-a"], opA)).ok, false);
  const fresh = must(observeRelease(repeated, good(releaseA, ["handoff-a"], opB)));
  assert.equal(promoteRelease(fresh).ok, true);
});

test("release state and nested evidence cannot be changed after validation", () => {
  const candidate = must(requestRelease(activeA(), releaseB, bRequirements, opB));
  if (candidate.desired === undefined || candidate.requirements === undefined) throw new Error("invalid fixture");
  assert.equal(Reflect.set(candidate.desired, "planDigest", "0".repeat(64)), false);
  assert.equal(Reflect.set(candidate.requirements, "rollbackCompatible", false), false);
  assert.equal(Reflect.set(candidate.requirements.requiredHandoffs, "0", "other"), false);
  const verified = must(observeRelease(candidate, good(releaseB, ["handoff-b"])));
  if (verified.observed === undefined) throw new Error("invalid fixture");
  assert.equal(Reflect.set(verified.observed, "outcomes", "clearer"), false);
  assert.equal(Reflect.set(verified.observed.release, "commit", "0".repeat(40)), false);
  assert.equal(Reflect.set(verified.observed.completedHandoffs, "0", "other"), false);
  const promoted = must(promoteRelease(verified));
  if (promoted.verifiedActive === undefined || promoted.lastKnownGood === undefined) throw new Error("invalid fixture");
  assert.equal(Reflect.set(promoted.verifiedActive, "commit", "0".repeat(40)), false);
  assert.deepEqual(promoted.lastKnownGood, releaseB);
});
