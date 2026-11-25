/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types -- models current runtime observations, lost acknowledgements and restart handles */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import type { ServiceObservation } from "../../src/contracts/swarm-service.ts";
import type { CheckContainerFence } from "../../src/contracts/check-container-fence.ts";
import type { ManagedServiceAction } from "../../src/contracts/managed-swarm-service.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { parseManagedCheckCessation } from "../../src/server/deployment/managed-check-cessation-state.ts";
import { managedCheckCessation } from "../../src/server/deployment/managed-check-cessation.ts";

const fixture = async (t: TestContext) => {
  const { plan } = await managedPlanFixture(); const spec = plan.services["worker"]; assert.ok(spec); const path = await mkdtemp(join(tmpdir(), "kayra-check-cessation-")); const artifacts = await openArtifactStore(join(path, "artifacts"));
  let journal = await openJournal(path); let clock = 1000; let stopped = false; let allowed = true; let lost = false; let reads = 0;
  const action = spec.owner.incarnation + ":3"; const target = { action: { app: spec.owner.app, incarnation: spec.owner.incarnation, dataOwner: spec.owner.dataOwner, service: "worker", action: action + ":apply:1", plan: managedServiceDigest(spec), effect: "apply" as const, deadline: 90000 }, service: "s".repeat(25), task: "t".repeat(25), container: "a".repeat(64) };
  const source = { application: plan, run: randomUUID(), action, createdAt: 1000, deadline: 91000, checks: [{ target, native: { id: target.service, version: 5 } }] };
  const calls: ManagedServiceAction[] = [];
  let observed: ServiceObservation = { status: "owned", id: target.service, version: 5, action: target.action.action, effect: "apply", taskEffect: "apply", plan: target.action.plan, taskPlan: target.action.plan, tombstone: false, containersConverged: true, containersStopped: false, retainedInputsCleared: false, specMatches: true, replicas: 1, endpoint: "vip", update: "completed", tasks: [] };
  const ports = { ...artifacts, now: () => clock, authorize: () => Promise.resolve(allowed), services: {
    observe: () => Promise.resolve(observed), tombstone: (requested: ManagedServiceAction, expected: { readonly id: string; readonly version: number } | null) => {
      assert.equal(observed.status, "owned"); assert.ok(expected); assert.equal(expected.id, observed.id); assert.equal(expected.version, observed.version); assert.ok(requested.action.startsWith(action + ":checks:")); calls.push(requested);
      observed = { ...observed, version: observed.version + 1, action: requested.action, effect: requested.effect, taskEffect: "remove", tombstone: true, retainedInputsCleared: requested.effect === "scrub", containersStopped: true, replicas: 0, endpoint: "dnsrr", tasks: [] };
      return lost ? Promise.reject(new Error("lost cleanup acknowledgement")) : Promise.resolve("acknowledged" as const);
    },
  }, containers: { observe: (input: CheckContainerFence) => {
    reads++; assert.deepEqual(input.target, target); assert.equal(input.barrier.effect, "scrub"); assert.ok(calls.at(-1)?.effect === "scrub");
    return Promise.resolve(stopped ? { status: "fenced" as const, kind: "stopped" as const, native: input.native, checkedAt: clock } : { status: "pending" as const });
  } } };
  let lostWrite: "before" | "after" | undefined;
  const openOwner = () => managedCheckCessation({ read: () => journal.read(), write: async (value) => { const failure = lostWrite; lostWrite = undefined; if (failure === "before") throw new Error("fixture before replacement"); await journal.write(value); if (failure === "after") throw new Error("fixture after replacement"); } }, ports);
  let owner = openOwner(); t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  const drive = async () => { for (let i = 0; i < 24; i++) { const value = await owner.tick(); if (value.phase !== "fencing" || reads > 0) return value; } throw new Error("fixture did not reach container inspection"); };
  return { source, spec, calls, failWrite: (when: "before" | "after") => { lostWrite = when; }, owner: () => owner, drive, stop: () => { stopped = true; }, lose: () => { lost = true; }, deny: () => { allowed = false; }, now: (value: number) => { clock = value; }, reads: () => reads,
    reopen: async () => { await journal.close(); journal = await openJournal(path, "existing"); owner = openOwner(); } };
};

test("unknown check cleanup scrubs the owned service but requires the pinned container to stop before certification", async (t) => {
  const lab = await fixture(t); await lab.owner().prepare(lab.source); assert.equal(lab.calls.length, 0); lab.lose();
  const waiting = await lab.drive(); assert.equal(waiting.phase, "fencing"); assert.equal(waiting.nodes[0]?.proofs.length, 0); assert.deepEqual(lab.calls.map((call) => call.effect), ["remove", "scrub"]);
  await lab.reopen(); lab.stop(); await lab.owner().tick(); const done = await lab.owner().tick(); assert.equal(done.phase, "complete"); assert.equal(done.nodes[0]?.proofs[0]?.container, lab.source.checks[0]?.target.container); assert.equal(lab.calls.length, 2);
  lab.now(999999); await lab.reopen(); assert.deepEqual(await lab.owner().prepare(lab.source), done); assert.equal((await lab.owner().tick()).deadline, 91000); assert.equal(lab.calls.length, 2);
});

test("check cleanup keeps its original deadline and held state across reopening without new service writes", async (t) => {
  const lab = await fixture(t); await lab.owner().prepare(lab.source); await lab.drive(); const calls = lab.calls.length; lab.now(lab.source.deadline);
  const held = await lab.owner().tick(); assert.equal(held.phase, "held"); assert.equal(held.reason, "deadline"); await lab.reopen(); assert.deepEqual(await lab.owner().tick(), held); assert.equal(lab.calls.length, calls);
});

test("check cleanup refuses retained dependencies, foreign owners and revoked effect authority", async (t) => {
  const lab = await fixture(t); const ref = lab.source.checks[0]; assert.ok(ref); const db = lab.source.application.services["db"]; assert.ok(db);
  await assert.rejects(lab.owner().prepare({ ...lab.source, checks: [{ ...ref, target: { ...ref.target, action: { ...ref.target.action, service: "db", plan: managedServiceDigest(db) } } }] }), /scope disagrees/);
  await assert.rejects(lab.owner().prepare({ ...lab.source, checks: [{ ...ref, target: { ...ref.target, action: { ...ref.target.action, dataOwner: randomUUID() } } }] }), /scope disagrees/);
  assert.equal(lab.calls.length, 0); await lab.owner().prepare(lab.source); lab.deny(); const held = await lab.owner().tick(); assert.equal(held.phase, "held"); assert.equal(held.reason, "authorization"); assert.equal(lab.calls.length, 0);
});

for (const when of ["before", "after"] as const) for (const cut of [1, 3, 5, 6]) test(`check cessation reopens uncertain ${when} journal replacement at effect boundary ${String(cut)}`, async (t) => {
  const lab = await fixture(t); lab.stop();
  if (cut > 0) { await lab.owner().prepare(lab.source); for (let i = 1; i < cut; i++) await lab.owner().tick(); }
  lab.failWrite(when); await assert.rejects(cut === 0 ? lab.owner().prepare(lab.source) : lab.owner().tick(), /uncertain/);
  const writes = lab.calls.length; await assert.rejects(lab.owner().tick(), /uncertain/); assert.equal(lab.calls.length, writes);
  await lab.reopen(); await lab.owner().prepare(lab.source);
  for (let i = 0; i < 24; i++) { const value = await lab.owner().tick(); if (value.phase === "complete") break; assert.equal(value.phase, "fencing"); }
  if (when === "after" && cut === 3) { // Dispatch intent survived; its native invocation may still arrive. Never resend it or certify cessation.
    assert.equal((await lab.owner().read())?.phase, "fencing"); assert.deepEqual(lab.calls.map((call) => call.effect), ["remove"]); lab.now(lab.source.deadline); assert.equal((await lab.owner().tick()).phase, "held");
  } else { const completed = await lab.owner().read(); assert.equal(completed?.phase, "complete"); assert.deepEqual(lab.calls.map((call) => call.effect), ["remove", "scrub"]); }
  assert.equal((await lab.owner().read())?.deadline, lab.source.deadline);
});

test("check cessation rejects barrier ownership substitution even when its native IDs match", async (t) => {
  const lab = await fixture(t); await lab.owner().prepare(lab.source); const value = await lab.drive(); const node = value.nodes[0]; assert.ok(node); const barrier = node.barrier; assert.ok(barrier);
  assert.throws(() => parseManagedCheckCessation({ ...value, nodes: [{ ...node, barrier: { ...barrier, action: { ...barrier.action, dataOwner: randomUUID() } } }] }), /disagrees/);
});
