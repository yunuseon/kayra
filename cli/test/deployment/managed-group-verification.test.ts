/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- models check processes, workload changes and journal interruption */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedRecoveryVerificationFixture, managedVerificationFixture } from "./managed-verification-fixture.ts";
import { managedVerificationSnapshot } from "../../src/server/deployment/managed-verification-source.ts";
import { managedGroupVerification, parseManagedGroupVerification } from "../../src/server/deployment/managed-group-verification.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import type { ManagedServiceAction } from "../../src/contracts/managed-swarm-service.ts";

const fixture = async (t: TestContext, checks = true, recovery = false) => {
  const input = recovery ? await managedRecoveryVerificationFixture() : await managedVerificationFixture(checks); const snapshot = managedVerificationSnapshot(input); const path = await mkdtemp(join(tmpdir(), "kayra-group-verification-")); const artifacts = await openArtifactStore(join(path, "artifacts"));
  let journal = await openJournal(path); let clock = 1000; let creates = 0; let starts = 0; let fail = false; let uncertain = false; let routes = true; let admitted = true; let poison = false; let replacement = false;
  const runtime = new Map<string, { running: boolean; exitCode: number }>();
  const ports = { ...artifacts, now: () => clock, authorize: () => Promise.resolve(admitted), services: { observeDesired: (action: ManagedServiceAction) => {
    const witness = snapshot.witnesses.find((witness) => witness.name === action.service); assert.ok(witness);
    return Promise.resolve({ status: "owned" as const, ...witness.native, action: action.action, effect: action.effect, taskEffect: action.effect, plan: action.plan, taskPlan: action.plan, specMatches: true, tombstone: false, containersStopped: true, retainedInputsCleared: false, replicas: 1, endpoint: "vip" as const, update: "completed" as const,
      tasks: [{ id: action.service.padEnd(25, replacement ? "z" : "t"), incarnation: action.incarnation, action: action.action, effect: action.effect, plan: action.plan, desired: "running" as const, state: "running" as const, health: "healthy" as const }] });
  } }, readiness: { check: (action: ManagedServiceAction) => Promise.resolve({ app: action.app, service: action.service, incarnation: action.incarnation, action: action.action, plan: action.plan, checkedAt: clock, status: routes ? "ready" as const : "unready" as const }) }, checks: {
    select: (action: ManagedServiceAction, native: { readonly id: string }, task: string) => Promise.resolve({ status: "owned" as const, target: { action, service: native.id, task, container: "c".repeat(64) } }),
    create: () => { creates++; const id = String(creates).padStart(64, "a"); runtime.set(id, { running: false, exitCode: 0 }); return Promise.resolve({ status: "created" as const, id }); },
    start: (_plan: unknown, id: string) => { starts++; runtime.set(id, { running: false, exitCode: fail ? 7 : 0 }); return Promise.resolve(uncertain ? "uncertain" as const : "acknowledged" as const); },
    observe: (_plan: unknown, id: string) => { const process = runtime.get(id); return Promise.resolve(process === undefined ? { status: "absent" as const } : { status: "owned" as const, id, running: process.running, exitCode: process.exitCode }); },
  } };
  const view = () => ({ read: journal.read, write: async (value: Parameters<typeof journal.write>[0]) => { await journal.write(value); if (poison && parseManagedGroupVerification(value).steps.some((step) => step.execution?.phase === "starting")) throw new Error("uncertain synchronized Start intent"); } });
  let owner = managedGroupVerification(view(), checks ? ports : { ...ports, checks: undefined }); t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  const drive = async () => { for (let i = 0; i < 50; i++) { const state = await owner.tick(); if (state.phase !== "running") return state; } throw new Error("verification did not settle"); };
  return { input, snapshot, ports, owner: () => owner, journal: () => journal, drive, prepare: () => owner.prepare(input), creates: () => creates, starts: () => starts,
    fail: () => { fail = true; }, uncertain: () => { uncertain = true; }, routes: (value: boolean) => { routes = value; }, deny: () => { admitted = false; }, poison: () => { poison = true; }, replace: () => { replacement = true; }, now: (value: number) => { clock = value; },
    reopen: async () => { await journal.close(); poison = false; journal = await openJournal(path, "existing"); owner = managedGroupVerification(view(), checks ? ports : { ...ports, checks: undefined }); },
  };
};

test("application verification runs declared checks once and refreshes every workload and route before its certificate", async (t) => {
  const lab = await fixture(t); const initial = await lab.prepare(); lab.routes(false);
  for (let i = 0; i < 12; i++) await lab.owner().tick(); const pending = await lab.owner().read(); assert.equal(pending?.phase, "running"); assert.equal(pending.steps[0]?.execution?.phase, "complete"); assert.equal(lab.starts(), 1);
  await lab.reopen(); lab.routes(true); const done = await lab.drive(); assert.equal(done.phase, "verified"); assert.equal(done.deadline, initial.deadline); assert.deepEqual(done.verified?.observations.map((item) => item.name), ["db", "web", "worker"]); assert.equal(lab.creates(), 1); assert.equal(lab.starts(), 1);
  lab.now(999999); assert.deepEqual(await lab.prepare(), done); assert.deepEqual(await lab.owner().tick(), done);
});

test("known failed and ambiguous checks never verify an application or repeat Start", async (t) => {
  const failed = await fixture(t); await failed.prepare(); failed.fail(); assert.equal((await failed.drive()).reason, "check-failed"); assert.equal(failed.starts(), 1);
  const unknown = await fixture(t); await unknown.prepare(); unknown.uncertain(); const held = await unknown.drive(); assert.equal(held.reason, "check-unknown"); assert.equal(held.verified, null); await unknown.reopen(); assert.deepEqual(await unknown.owner().tick(), held); assert.equal(unknown.starts(), 1);
});

test("a successful check from a replaced task cannot certify the new task", async (t) => {
  const lab = await fixture(t); await lab.prepare(); lab.routes(false); for (let i = 0; i < 12; i++) await lab.owner().tick(); lab.replace(); lab.routes(true);
  const held = await lab.owner().tick(); assert.equal(held.phase, "held"); assert.equal(held.reason, "runtime"); assert.equal(held.verified, null); assert.equal(lab.starts(), 1);
});

test("no-check applications still require fresh native/routed verification without an Exec capability", async (t) => {
  const lab = await fixture(t, false); await lab.prepare(); assert.equal((await lab.drive()).phase, "verified"); assert.equal(lab.creates(), 0); assert.equal(lab.starts(), 0);
});

test("restart retains the source-derived deadline and expired or denied authority cannot execute checks", async (t) => {
  const expired = await fixture(t); const initial = await expired.prepare(); await expired.reopen(); expired.now(initial.deadline); assert.equal((await expired.owner().tick()).reason, "deadline"); assert.equal(expired.creates(), 0);
  const denied = await fixture(t); await denied.prepare(); denied.deny(); assert.equal((await denied.drive()).phase, "held"); assert.equal(denied.creates(), 0);
});

test("uncertain parent persistence requires reopening and does not turn initial zero into a check success", async (t) => {
  const lab = await fixture(t); const initial = await lab.prepare(); lab.poison(); await assert.rejects(lab.drive(), /uncertain/); assert.equal(lab.starts(), 0); await assert.rejects(lab.owner().tick(), /reopen/);
  await lab.reopen(); const held = await lab.drive(); assert.equal(held.reason, "check-unknown"); assert.equal(held.deadline, initial.deadline); assert.equal(lab.starts(), 0);
});

test("restored applications refresh their complete workload set under a distinct recovery check identity", async (t) => {
  const lab = await fixture(t, false, true); const initial = await lab.prepare(); const done = await lab.drive(); assert.equal(done.phase, "verified"); assert.notEqual(initial.checkRun, initial.run); assert.deepEqual(done.verified?.observations.map((item) => item.name), ["db", "web", "worker"]); assert.equal(lab.starts(), 0);
});
