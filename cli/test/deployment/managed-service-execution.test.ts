/* eslint-disable functional/no-let, functional/prefer-immutable-types -- owns crash injection and modeled runtime */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { OperationJournal } from "../../src/server/deployment/operation.ts";
import { typed } from "../../src/lib/typed.ts";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedServiceAction } from "../../src/contracts/managed-swarm-service.ts";
import type { ServiceObservation } from "../../src/contracts/swarm-service.ts";
import { managedServiceExecution } from "../../src/server/deployment/managed-service-execution.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";

const fixture = async (t: TestContext, deadline = 91000, retained = false) => {
  const { plan } = await managedPlanFixture(); const service = plan.services[retained ? "db" : "worker"]; assert.ok(service);
  const path = await mkdtemp(join(tmpdir(), "kayra-managed-effect-")); const artifacts = await openArtifactStore(join(path, "artifacts"));
  let journal = await openJournal(path); let clock = 1000; let calls = 0; let reactivations = 0; let lost = false; let loseWrite = false; let admitted = true;
  let observed: ServiceObservation = { status: "absent" };
  const action: ManagedServiceAction = { app: service.owner.app, incarnation: service.owner.incarnation, dataOwner: service.owner.dataOwner, service: service.service, action: service.owner.incarnation + ":2", plan: managedServiceDigest(service), deadline, effect: "apply" };
  const apply = () => {
      calls++;
      observed = { status: "owned", id: "s".repeat(25), version: 2, action: action.action, effect: "apply", taskEffect: "apply", plan: action.plan, taskPlan: action.plan,
        tombstone: false, containersStopped: true, retainedInputsCleared: false, specMatches: true, replicas: 1, endpoint: "vip", update: "completed",
        tasks: [{ id: "t".repeat(25), incarnation: action.incarnation, effect: "apply", plan: action.plan, action: action.action, desired: "running", state: "running", health: "healthy" }] };
      return lost ? Promise.reject(new Error("private lost acknowledgement")) : Promise.resolve("acknowledged" as const);
  };
  const ports = { ...artifacts, now: () => clock, authorize: () => Promise.resolve(admitted), runtime: {
    observeDesired: () => Promise.resolve(observed),
    apply, reactivate: () => { reactivations++; return apply(); },
  } };
  const view = () => typed<OperationJournal>({ read: journal.read, write: async (value) => {
    await journal.write(value); if (loseWrite) throw new Error("synchronized acknowledgement lost");
  } });
  let owner = managedServiceExecution(view(), ports);
  t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  return { plan, service, action, artifacts, ports, calls: () => calls, reactivations: () => reactivations, owner: () => owner, journal: () => journal,
    prepare: () => owner.prepare(service, action, null), now: (now: number) => { clock = now; }, lost: () => { lost = true; }, loseWrite: () => { loseWrite = true; }, deny: () => { admitted = false; },
    observe: (value: ServiceObservation) => { observed = value; },
    reopen: async (changed: Partial<typeof ports> = {}) => { await journal.close(); loseWrite = false; journal = await openJournal(path, "existing"); owner = managedServiceExecution(view(), { ...ports, ...changed }); },
  };
};

test("managed service intent is synchronized before dispatch and lost acknowledgement is observed without replay", async (t) => {
  const lab = await fixture(t); await lab.prepare(); lab.lost();
  const dispatched = await lab.owner().tick(); assert.equal(dispatched.phase, "observing"); assert.equal(lab.calls(), 1);
  await lab.reopen(); const complete = await lab.owner().tick(); assert.equal(complete.phase, "converged"); assert.equal(lab.calls(), 1);
  lab.now(999999); assert.deepEqual(await lab.prepare(), complete); assert.equal(lab.calls(), 1);
  assert.equal(JSON.stringify(await lab.journal().read()).includes("private"), false);
});

test("restart in dispatch intent before the actual write never sends a speculative create", async (t) => {
  const lab = await fixture(t); const initial = await lab.prepare();
  await lab.journal().write({ ...initial, phase: "observing" }); await lab.reopen();
  assert.equal((await lab.owner().tick()).phase, "observing"); assert.equal(lab.calls(), 0);
  lab.now(lab.action.deadline); const expired = await lab.owner().tick(); assert.equal(expired.phase, "held"); assert.equal(expired.reason, "deadline"); assert.equal(lab.calls(), 0);
});

test("authorization denial, stale ownership and immutable plan conflicts cannot dispatch", async (t) => {
  const lab = await fixture(t); const initial = await lab.prepare(); lab.deny();
  assert.equal((await lab.owner().tick()).reason, "authorization"); assert.equal(lab.calls(), 0);
  await assert.rejects(lab.owner().prepare(lab.service, { ...lab.action, deadline: lab.action.deadline + 1 }, null), /conflicts/);
  await assert.rejects(lab.owner().prepare(lab.service, { ...lab.action, dataOwner: "11111111-1111-4111-8111-111111111111" }, null), /scope/);
  assert.equal((await lab.owner().read())?.action.deadline, initial.action.deadline);
});

test("an ordinary existing retained dependency cannot acquire a replacement intent", async (t) => {
  const lab = await fixture(t); const db = lab.plan.services["db"]; assert.ok(db);
  await assert.rejects(lab.owner().prepare(db, { ...lab.action, service: "db", plan: managedServiceDigest(db) }, { id: "s".repeat(25), version: 1 }), /scope/);
  assert.equal(await lab.journal().read(), undefined); assert.equal(lab.calls(), 0);
});


test("uncertain intent persistence poisons the handle and restart cannot redispatch its possible effect", async (t) => {
  const lab = await fixture(t); await lab.prepare(); lab.loseWrite();
  await assert.rejects(lab.owner().tick(), /uncertain/); assert.equal(lab.calls(), 0);
  await assert.rejects(lab.owner().read(), /reopen/);
  await lab.reopen(); assert.equal((await lab.owner().tick()).phase, "observing"); assert.equal(lab.calls(), 0);
  lab.now(lab.action.deadline); assert.equal((await lab.owner().tick()).phase, "held");
});

test("an authorization response after timeout cannot trigger a later native write", async (t) => {
  const lab = await fixture(t, 1020); const authorized = Promise.withResolvers<boolean>();
  await lab.prepare(); await lab.reopen({ authorize: () => authorized.promise });
  const held = await lab.owner().tick(); assert.equal(held.phase, "held"); assert.equal(lab.calls(), 0);
  authorized.resolve(true); await Promise.resolve(); assert.equal(lab.calls(), 0);
});

test("healthy native evidence observed after the original deadline cannot certify convergence", async (t) => {
  const lab = await fixture(t); await lab.prepare(); await lab.owner().tick(); lab.now(lab.action.deadline);
  const held = await lab.owner().tick(); assert.equal(held.phase, "held"); assert.equal(held.reason, "deadline"); assert.equal(held.verified, null);
  await lab.reopen(); assert.deepEqual(await lab.owner().tick(), held); assert.equal(lab.calls(), 1);
});


test("retained reactivation is an explicit durable mode and an uncertain activation is never replayed", async (t) => {
  const lab = await fixture(t, 91000, true); lab.lost();
  const expected = { id: "s".repeat(25), version: 1 };
  const intent = await lab.owner().prepare(lab.service, lab.action, expected, "reactivate-retained"); assert.equal(intent.mode, "reactivate-retained");
  await lab.owner().tick(); assert.equal(lab.reactivations(), 1);
  await lab.reopen(); const done = await lab.owner().tick(); assert.equal(done.phase, "converged"); assert.equal(done.mode, "reactivate-retained");
  assert.equal(lab.calls(), 1); assert.equal(lab.reactivations(), 1);
  await assert.rejects(lab.owner().prepare(lab.service, lab.action, expected), /scope/);
});

test("reactivation mode cannot target consumers or create an absent dependency", async (t) => {
  const worker = await fixture(t); await assert.rejects(worker.owner().prepare(worker.service, worker.action, { id: "s".repeat(25), version: 1 }, "reactivate-retained"), /scope/);
  const db = await fixture(t, 91000, true); assert.throws(() => db.owner().prepare(db.service, db.action, null, "reactivate-retained"), /inconsistent/);
  assert.equal(await worker.journal().read(), undefined); assert.equal(await db.journal().read(), undefined);
});
