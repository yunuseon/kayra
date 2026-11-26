/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types -- observes native effects and injects interruption or ownership loss */
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { randomUUID } from "node:crypto";
import { strict as assert } from "node:assert";
import { managedLifecycleSourceDigest, parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { preparedForwardFixture } from "./indexed-forward-prepared-fixture.ts";
import { managedForwardCleanupRuntime } from "../../src/server/composition/managed-forward-cleanup-runtime.ts";
import { reconcileManagedForwardWork } from "../../src/server/deployment/managed-forward-work.ts";
import { managedForwardOperation } from "../../src/server/deployment/managed-forward-operation.ts";
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

test("forward dispatcher reopens an accepted reservation and activates it without replaying consumer writes", async (t) => {
  const lab = await fixture(t);
  const pending = () => lab.index().pendingManagedForwardRequests(lab.ports);
  const run = () => reconcileManagedForwardWork(lab.index(), { ...lab.ports, runtime: lab.factory,
    retained: () => lab.runtime.services.observeDesired, observeHost: lab.runtime.observeHost, authorizeTransfer: () => Promise.resolve(true),
  });
  assert.deepEqual(await pending(), [lab.request]);
  const projected = await lab.index().publishedDeploymentStatus("shop", lab.ports);
  assert.ok(projected?.version === 3);
  assert.deepEqual(projected.forwardRecovery, { request: lab.request.request, phase: "initializing", deadline: lab.reservation.deadline });
  for (let i = 0; i < 30 && lab.effects.length === 0; i++) await run();
  assert.equal(lab.effects.length, 1);
  await lab.reopen(); lab.clock(2000);
  assert.deepEqual(await pending(), [lab.request]);
  for (let i = 0; i < 60 && (await pending()).length > 0; i++) {
    const result = await run();
    assert.ok(result[0]?.outcome === "fencing" || result[0]?.outcome === "activated", JSON.stringify(result));
  }
  assert.deepEqual(await pending(), []);
  assert.deepEqual(await run(), []);
  assert.deepEqual(await lab.index().pendingManagedDeployments(), [{ app: "shop", run: lab.request.request }]);
  const successor = await lab.index().acceptedManagedRequest("shop", lab.request.request, lab.ports);
  assert.equal(successor?.source.forward?.decision, lab.selected.id);
  assert.equal(lab.effects.length, 4);
  assert.equal(new Set(lab.effects.map((item) => item.action + item.service)).size, 4);
});

test("the owner reports an expired cleanup as held and stops polling that request", async (t) => {
  const lab = await fixture(t);
  const index = lab.index();
  await index.prepareManagedForwardCleanup("shop", lab.request, lab.ports);
  lab.clock(lab.reservation.deadline);
  const runtime = () => reconcileManagedForwardWork(index, { ...lab.ports, runtime: lab.factory,
    retained: () => lab.runtime.services.observeDesired, observeHost: lab.runtime.observeHost, authorizeTransfer: () => Promise.resolve(true),
  });
  assert.equal((await runtime())[0]?.outcome, "held");
  const status = await index.publishedDeploymentStatus("shop", lab.ports);
  assert.ok(status?.version === 3);
  assert.deepEqual(status.forwardRecovery, { request: lab.request.request, phase: "held", deadline: lab.reservation.deadline });
  assert.deepEqual(await runtime(), []);
  assert.equal(lab.effects.length, 0);
});

test("forward control binds the explicit operator reason and exact build before queuing reconciliation", async (t) => {
  const lab = await preparedForwardFixture(t);
  const command = () => managedForwardOperation(lab.index(), { ...lab.ports, actor: lab.actor, canAccess: (app) => Promise.resolve(app === "shop"),
    builds: { ...lab.ports, prepare: () => Promise.reject(new Error("retained forward build must be reused")) },
    plans: { volumeKeys: () => Promise.resolve(lab.volumes.map((volume) => volume.key)), preview: (registration, commit, artifact) => {
      assert.deepEqual(registration, lab.built.build.registration);
      assert.equal(commit, lab.request.commit); assert.equal(artifact, lab.built.build.artifact);
      return Promise.resolve(lab.candidate);
    } },
    authorizeReservation: (decision, _candidate, operator) => Promise.resolve(decision.id === lab.selected.id && operator.reason === lab.request.reason),
  });
  await assert.rejects(command()({ ...lab.request, app: "another" }), /outside scope/);
  const initial = await command()(lab.request);
  assert.equal(initial.phase, "initializing"); assert.equal(initial.decision, lab.selected.id);
  assert.deepEqual(await lab.index().pendingManagedForwardRequests(lab.ports), [lab.request]);
  assert.equal((await lab.readEnvelope()).forward?.operator.reason, lab.request.reason);
  await lab.reopen();
  assert.deepEqual(await command()(lab.request), initial);
  await assert.rejects(command()({ ...lab.request, reason: "a different recorded decision" }), /conflicts/);
});

test("a same-request retry survives activation during plan preparation", async (t) => {
  const lab = await fixture(t);
  const index = lab.index();
  const dispatch = () => reconcileManagedForwardWork(index, { ...lab.ports, runtime: lab.factory,
    retained: () => lab.runtime.services.observeDesired, observeHost: lab.runtime.observeHost, authorizeTransfer: () => Promise.resolve(true),
  });
  const command = managedForwardOperation(index, { ...lab.ports,
    actor: lab.actor, canAccess: () => Promise.resolve(true),
    builds: { ...lab.ports, prepare: () => Promise.reject(new Error("retained forward build must be reused")) },
    plans: { volumeKeys: () => Promise.resolve(lab.volumes.map((volume) => volume.key)), preview: async () => {
      for (let i = 0; i < 60 && (await index.pendingManagedForwardRequests(lab.ports)).length > 0; i++) await dispatch();
      const accepted = await index.acceptedManagedRequest("shop", lab.request.request, lab.ports);
      assert.ok(accepted);
      return lab.candidate;
    } },
  });
  const result = await command(lab.request);
  const accepted = await index.acceptedManagedRequest("shop", lab.request.request, lab.ports);
  assert.ok(accepted);
  assert.deepEqual(result, { version: 1, request: lab.request.request, decision: lab.selected.id, phase: "activated",
    deploymentDeadline: accepted.request.deadline });
  assert.deepEqual(await command(lab.request), result);
});

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
  const install = () => lab.index().installManagedForwardRoot("shop", lab.request, lab.ports, lab.factory, retained);
  await assert.rejects(install(), /requires the transferred charge/);
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
  assert.ok(resources);
  assert.equal(resources.charges.length, 1);
  const charge = resources.charges[0]; assert.ok(charge);
  assert.equal(charge.sequence, 4);
  assert.equal(charge.result, "pending");
  assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
  assert.equal((await lab.readEnvelope()).fence?.lifecycle.phase, "registered");
  lab.cut("root-install-after");
  await assert.rejects(install(), /synchronization uncertain/);
  await lab.reopen();
  const installed = await install();
  assert.equal(installed.operation.phase, "held");
  assert.equal(installed.operation.reason, "deadline");
  assert.equal(installed.operation.admitted, true);
  assert.equal(installed.operation.admissionDeadline, moved.deadline);
  assert.equal(installed.compatibilityEpoch, lab.held.compatibilityEpoch);
  assert.equal(installed.active, null);
  assert.deepEqual(installed.lastGood, lab.held.lastGood);
  assert.ok(installed.history);
  const archived: unknown = JSON.parse(await lab.artifacts.read(installed.history));
  assert.deepEqual(archived, { previous: lab.held.history, state: lab.held });
  await lab.reopen();
  assert.deepEqual(await install(), installed);
  await assert.rejects(lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime), /forward continuation owns lifecycle/);
  assert.deepEqual(await lab.index().resourceSnapshot(), resources);
  const activate = () => lab.index().activateManagedForward("shop", lab.request, lab.ports, lab.factory, retained);
  lab.cut("activation-after");
  await assert.rejects(activate(), /injected after/);
  await lab.reopen();
  const accepted = await activate();
  assert.equal(accepted.run, moved.run);
  assert.equal(accepted.source, moved.source);
  const activated = await lab.readEnvelope();
  assert.equal(activated.forward, undefined);
  assert.deepEqual(activated.managed?.find((entry) => entry.run === lab.source.run)?.completion,
    { rootSnapshot: lab.reservation.blocked.checkpoint, outcome: "superseded", disposition: "failure", successor: moved.run });
  await lab.reopen();
  assert.deepEqual(await activate(), accepted);
  assert.deepEqual(await lab.index().tickManagedDeployment("shop", moved.run, lab.runtime), installed);
  assert.deepEqual(await lab.index().resourceSnapshot(), resources);
  assert.deepEqual((await lab.index().pendingManagedDeployments()).map((item) => item.run), [moved.run]);
  const nextSelection = await lab.index().selectManagedForward("shop", {
    ...lab.request, request: randomUUID(), blockedRun: moved.run, commit: "9".repeat(40),
  }, lab.actor, lab.ports);
  assert.equal(nextSelection.audit.blocked.compatibilityEpoch, lab.held.compatibilityEpoch);
  const status = await lab.index().managedDeploymentStatus("shop", lab.runtime);
  assert.equal(status?.rollback, "data-fenced");
  assert.equal(status.verifiedActive, null);
  assert.equal(lab.effects.length, 4);
});

test("a verified forward successor becomes the baseline for ordinary proposals", async (t) => {
  const lab = await fixture(t);
  await lab.index().prepareManagedForwardCleanup("shop", lab.request, lab.ports);
  for (let i = 0; i < 60; i++) {
    const state = await lab.index().tickManagedForwardCleanup("shop", lab.request, lab.ports, lab.factory);
    if (state.phase !== "fencing") { assert.equal(state.phase, "complete"); break; }
  }
  const retained = lab.runtime.services.observeDesired;
  await lab.index().prepareManagedForwardHandoff("shop", lab.request, lab.ports, lab.factory, retained);
  await lab.index().transferManagedForwardAdmission("shop", lab.request,
    { ...lab.ports, observeHost: lab.runtime.observeHost, authorizeTransfer: () => Promise.resolve(true) }, lab.factory, retained);
  await lab.index().installManagedForwardRoot("shop", lab.request, lab.ports, lab.factory, retained);
  const successor = await lab.index().activateManagedForward("shop", lab.request, lab.ports, lab.factory, retained);
  const runtime = { ...lab.runtime, allocations: { reconcile: () => Promise.resolve("ready" as const) } };
  for (let i = 0; i < 100; i++) {
    const state = await lab.index().tickManagedDeployment("shop", successor.run, runtime);
    assert.notEqual(state?.operation.phase, "held");
    if (state?.operation.phase === "complete") break;
  }
  const status = await lab.index().managedDeploymentStatus("shop", runtime);
  assert.equal(status?.operation.phase, "complete");
  assert.equal(status.verifiedActive?.run, successor.run);

  const build = await lab.index().prepareBuild("shop", "9".repeat(40), {
    ...lab.artifacts, now: lab.runtime.now, images: lab.ports.images, prepare: () => Promise.resolve(JSON.stringify({ commit: "9".repeat(40) })),
  });
  const next = parseManagedApplicationPlan({ ...lab.candidate, commit: build.commit, artifact: build.artifact });
  assert.ok(next.ok);
  const source = await lab.index().proposeManagedDeployment("shop", next.value, randomUUID(), lab.ports);
  assert.equal(source.version, 2);
  assert.deepEqual(source.previous?.source.application, lab.candidate);
  assert.equal(source.retained[0]?.kind, "active");
});
