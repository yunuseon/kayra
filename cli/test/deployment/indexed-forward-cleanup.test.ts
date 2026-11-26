/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types -- observes native effects and injects interruption or ownership loss */
import { strict as assert } from "node:assert";
import { managedLifecycleSourceDigest, parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { preparedForwardFixture } from "./indexed-forward-prepared-fixture.ts";
import { managedForwardCleanupRuntime } from "../../src/server/composition/managed-forward-cleanup-runtime.ts";
import type { ManagedForwardCleanupContext } from "../../src/contracts/managed-forward-cleanup-context.ts";
import type { ManagedSwarmServicePort, ManagedServiceAction } from "../../src/contracts/managed-swarm-service.ts";

const fixture = async (t: TestContext) => {
  const lab = await preparedForwardFixture(t); const reservation = await lab.index().reserveManagedForward("shop", lab.request, lab.candidate, lab.operator, lab.ports);
  const effects: ManagedServiceAction[] = []; let owned = true;
  const factory = (context: ManagedForwardCleanupContext) => managedForwardCleanupRuntime(context, { now: lab.runtime.now,
    authority: { allowed: (base, permission) => { assert.equal(base.action, lab.source.action); assert.equal(base.run, lab.source.run); assert.ok(permission.kind === "recovery" || permission.kind === "job" && permission.effect === "observe"); return Promise.resolve(owned); } },
    native: { services: { observe: lab.runtime.services.observe, tombstone: (...args: Parameters<ManagedSwarmServicePort["tombstone"]>) => { const [action, expected] = args; effects.push(action); return lab.runtime.services.tombstone(action, expected); } }, jobs: lab.runtime.jobs, containers: { observe: () => Promise.reject(new Error("no unknown checks expected in this fixture")) } },
  });
  return { ...lab, reservation, factory, effects, effectsPath: join(lab.selectionDirectory, "effects"), denyCleanup: () => { owned = false; } };
};

test("indexed forward cleanup synchronizes its child before publication and keeps the held root, data service and charge", async (t) => {
  const lab = await fixture(t); const resources = await lab.index().resourceSnapshot(); const db = lab.services.get("db");
  const prepared = await lab.index().prepareManagedForwardCleanup("shop", lab.request, lab.ports); assert.equal(prepared.reservation.phase, "fencing"); assert.ok(prepared.state); assert.equal(prepared.state.phase, "fencing"); assert.equal(lab.effects.length, 0);
  const context = await lab.index().managedForwardCleanupContext("shop", lab.request, lab.ports); assert.equal(context.action, lab.reservation.action); assert.equal(context.blocked.action, lab.source.action); assert.equal(context.deadline, lab.reservation.deadline);
  const stoppedOnce = () => lab.effects.length > 0;
  for (let i = 0; i < 30 && !stoppedOnce(); i++) await lab.index().tickManagedForwardCleanup("shop", lab.request, lab.ports, lab.factory);
  assert.equal(lab.effects.length, 1); await lab.reopen(); lab.clock(2000);
  for (let i = 0; i < 60; i++) { const state = await lab.index().tickManagedForwardCleanup("shop", lab.request, lab.ports, lab.factory); if (state.phase !== "fencing") { assert.equal(state.phase, "complete"); break; } }
  const complete = await lab.index().prepareManagedForwardCleanup("shop", lab.request, { ...lab.ports, compare: () => Promise.reject(new Error("published cleanup must not prepare another source")) }); assert.ok(complete.state); assert.equal(complete.state.phase, "complete"); assert.equal(complete.state.deadline, lab.reservation.deadline); assert.equal(lab.effects.length, 4); assert.equal(new Set(lab.effects.map((action) => action.action + action.service)).size, 4);
  assert.ok(lab.effects.every((action) => action.action.startsWith(lab.reservation.action + ":quiesce:") && action.service !== "db")); assert.deepEqual(lab.services.get("db"), db); assert.deepEqual(await lab.index().resourceSnapshot(), resources); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
  const inspect = (retained = lab.runtime.services.observeDesired) =>
    lab.index().inspectManagedForwardHandoff("shop", lab.request, lab.ports, lab.factory, retained);
  const evidence = await inspect();
  assert.deepEqual(evidence.retained.map((reference) => reference.name), ["db"]);
  assert.equal(evidence.retained[0]?.native.id, db?.status === "owned" ? db.id : undefined);
  await assert.rejects(inspect(() => Promise.resolve({ status: "unavailable" })), /retained dependency is not ready/);
  const worker = lab.services.get("worker"); assert.ok(worker?.status === "owned");
  lab.services.set("worker", { ...worker, replicas: 1 });
  try { await assert.rejects(inspect(), /consumer fence changed/); } finally { lab.services.set("worker", worker); }
  assert.deepEqual(await lab.index().resourceSnapshot(), resources);
  const prepareHandoff = () => lab.index().prepareManagedForwardHandoff("shop", lab.request, lab.ports, lab.factory, lab.runtime.services.observeDesired);
  lab.cut("handoff-publication-after");
  await assert.rejects(prepareHandoff(), /injected/);
  const published = (await lab.readEnvelope()).forward;
  assert.equal(published?.phase, "transferring");
  assert.equal(published.handoff.createdAt, 2000);
  assert.equal(published.handoff.deadline, 92000);
  await lab.reopen(); lab.clock(93000);
  const handoff = await lab.index().prepareManagedForwardHandoff("shop", lab.request, lab.ports,
    () => { throw new Error("published intent must replay without new observations"); }, lab.runtime.services.observeDesired);
  assert.deepEqual(handoff.reservation, published);
  const successor = handoff.source;
  assert.equal(managedLifecycleSourceDigest(successor), published.handoff.source);
  assert.deepEqual(parseManagedLifecycleSource(JSON.parse(JSON.stringify(successor))), successor);
  assert.equal(successor.retained[0]?.kind, "forward");
  assert.deepEqual(successor.retained[0].native, evidence.retained[0]?.native);
  assert.throws(() => parseManagedLifecycleSource({ ...successor, version: 2 }), /successor source/);
  assert.throws(() => parseManagedLifecycleSource({ ...successor, previous: lab.source.previous }), /successor source/);
  await assert.rejects(lab.index().requestManagedDeployment("shop", successor, lab.runtime), /owning admission handoff/);
  assert.deepEqual(await lab.index().resourceSnapshot(), resources);
  assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
  await lab.reopen(); assert.deepEqual(await lab.index().tickManagedForwardCleanup("shop", lab.request, lab.ports, lab.factory), complete.state); assert.equal(lab.effects.length, 4);
});

for (const point of ["cleanup-child-before", "cleanup-child-after", "cleanup-publication-before", "cleanup-publication-after"] as const) test(`indexed forward initialization recovers ${point} without fresh deadlines or native writes`, async (t) => {
  const lab = await fixture(t); lab.cut(point); await assert.rejects(lab.index().prepareManagedForwardCleanup("shop", lab.request, lab.ports), /injected/);
  assert.equal(lab.effects.length, 0); await lab.reopen(); lab.clock(2000);
  const prepared = await lab.index().prepareManagedForwardCleanup("shop", lab.request, lab.ports); assert.equal(prepared.reservation.phase, "fencing"); assert.ok(prepared.state); assert.equal(prepared.state.createdAt, lab.reservation.createdAt); assert.equal(prepared.state.deadline, lab.reservation.deadline); assert.equal(lab.effects.length, 0); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
});

test("published forward cleanup refuses to recreate a missing private journal", async (t) => {
  const lab = await fixture(t); await lab.index().prepareManagedForwardCleanup("shop", lab.request, lab.ports); const path = join(lab.effectsPath, "state.json"); await rename(path, path + ".kept");
  try { await assert.rejects(lab.index().prepareManagedForwardCleanup("shop", lab.request, lab.ports), /missing|exist|journal/); await assert.rejects(readFile(path), /ENOENT/); assert.equal(lab.effects.length, 0); } finally { await rename(path + ".kept", path); }
  assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
});

test("expired initialization and revoked native cleanup authority preserve the original pending charge", async (t) => {
  const expired = await fixture(t); const before = await expired.index().resourceSnapshot(); expired.clock(expired.reservation.deadline);
  const stalled = await expired.index().prepareManagedForwardCleanup("shop", expired.request, expired.ports); assert.equal(stalled.reservation.phase, "held"); assert.equal(stalled.state, null);
  await expired.reopen(); expired.clock(expired.reservation.deadline + 1000); assert.deepEqual(await expired.index().prepareManagedForwardCleanup("shop", expired.request, expired.ports), stalled); await assert.rejects(readFile(join(expired.effectsPath, "state.json")), /ENOENT/); assert.deepEqual(await expired.index().resourceSnapshot(), before); assert.equal(expired.effects.length, 0);
  const revoked = await fixture(t); await revoked.index().prepareManagedForwardCleanup("shop", revoked.request, revoked.ports); revoked.denyCleanup();
  const held = await revoked.index().tickManagedForwardCleanup("shop", revoked.request, revoked.ports, revoked.factory); assert.equal(held.phase, "held"); assert.equal(held.deadline, revoked.reservation.deadline); assert.equal(revoked.effects.length, 0); assert.deepEqual(await revoked.index().managedState("shop", revoked.runtime), revoked.held);
});

test("the global admission writer transfers capacity exactly once after fresh handoff evidence", async (t) => {
  const lab = await fixture(t);
  const original = await lab.index().resourceSnapshot();
  await lab.index().prepareManagedForwardCleanup("shop", lab.request, lab.ports);
  for (let i = 0; i < 60; i++) {
    const state = await lab.index().tickManagedForwardCleanup("shop", lab.request, lab.ports, lab.factory);
    if (state.phase !== "fencing") { assert.equal(state.phase, "complete"); break; }
  }
  const retained = lab.runtime.services.observeDesired;
  const transfer = (authorize = true) => lab.index().transferManagedForwardAdmission("shop", lab.request,
    { ...lab.ports, observeHost: lab.runtime.observeHost, authorizeTransfer: () => Promise.resolve(authorize) }, lab.factory, retained);
  await assert.rejects(transfer(), /requires its published intent/);
  const prepared = await lab.index().prepareManagedForwardHandoff("shop", lab.request, lab.ports, lab.factory, retained);
  assert.equal(prepared.reservation.phase, "transferring");
  await assert.rejects(transfer(false), /authority unavailable/);
  lab.cut("transfer-write-before");
  await assert.rejects(transfer(), /injected before/);
  await lab.reopen();
  assert.deepEqual(await lab.index().resourceSnapshot(), original);
  lab.cut("transfer-write-after");
  await assert.rejects(transfer(), /injected after/);
  await lab.reopen();

  lab.clock(prepared.reservation.handoff.deadline + 1);
  const moved = await transfer(false);
  assert.equal(moved.source, prepared.reservation.handoff.source);
  assert.equal(moved.deadline, prepared.reservation.handoff.deadline);
  const resources = await lab.index().resourceSnapshot();
  assert.equal(resources?.charges.length, 1);
  assert.equal(resources.charges[0]?.sequence, 4);
  assert.equal(resources.charges[0]?.result, "pending");
  assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
  assert.equal((await lab.readEnvelope()).fence?.lifecycle.phase, "registered");
  assert.equal(lab.effects.length, 4);
});
