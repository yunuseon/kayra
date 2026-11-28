import { strict as assert } from "node:assert";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { preparedForwardFixture } from "./indexed-forward-prepared-fixture.ts";
import { parseLifecycleEnvelope } from "../../src/server/deployment/lifecycle-envelope.ts";

const fixture = preparedForwardFixture;

test("forward reservation fences ordinary mutation without superseding the held run or changing its charge", async (t) => {
  const lab = await fixture(t); const resources = await lab.index().resourceSnapshot(); const before = await lab.readEnvelope();
  const reservation = await lab.index().reserveManagedForward("shop", lab.request, lab.candidate, lab.operator, lab.ports); assert.equal(reservation.phase, "initializing"); assert.deepEqual(reservation.operator, lab.operator); assert.notDeepEqual(reservation.operator.actor, lab.selected.audit.actor); assert.equal(reservation.action, lab.incarnation + ":4"); assert.equal(reservation.run, lab.request.request); assert.equal(reservation.deadline, reservation.createdAt + 90000);
  const after = await lab.readEnvelope(); assert.equal(after.fence?.nextAction, 5); assert.deepEqual(after.fence.lifecycle, before.fence?.lifecycle); assert.deepEqual(after.managed, before.managed); assert.deepEqual(after.operations, before.operations); assert.equal(lab.authorizations(), 1);
  assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held); assert.deepEqual(await lab.index().resourceSnapshot(), resources);
  await assert.rejects(lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime), /forward continuation owns lifecycle/);
  await assert.rejects(lab.index().cancelManagedDeployment("shop", lab.source.run, lab.runtime), /forward continuation owns lifecycle/);
  await assert.rejects(lab.index().resolveManagedMigration("shop", { app: "shop", run: lab.source.run, step: "schema", outcome: "applied", reason: "A later assertion must not alter the frozen checkpoint" }, lab.actor, lab.runtime), /forward continuation owns lifecycle/);
  assert.equal(await lab.index().managedForwardBuildGrant("shop", lab.request, lab.ports), undefined); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held); assert.deepEqual(await lab.index().resourceSnapshot(), resources);
  for (const forward of [{ ...reservation, action: lab.incarnation + ":5" }, { ...reservation, blocked: { ...reservation.blocked, source: "f".repeat(64) } }, { ...reservation, deadline: reservation.deadline + 1 }]) assert.equal(parseLifecycleEnvelope({ ...after, forward }).ok, false);
});

test("replaying a durable forward reservation preserves its original deadline without a new grant or root repair", async (t) => {
  const lab = await fixture(t); const reservation = await lab.index().reserveManagedForward("shop", lab.request, lab.candidate, lab.operator, lab.ports);
  await lab.reopen(); lab.clock(reservation.deadline + 1); lab.denyReservation(); const root = join(lab.selectionDirectory, "..", "..", "state.json"); await rename(root, root + ".kept");
  try { assert.deepEqual(await lab.index().reserveManagedForward("shop", lab.request, lab.candidate, lab.operator, lab.ports), reservation); await assert.rejects(readFile(root), /ENOENT/); } finally { await rename(root + ".kept", root); }
  await assert.rejects(lab.index().reserveManagedForward("shop", lab.request, lab.candidate, { ...lab.operator, actor: { ...lab.actor, identity: "another-operator" } }, lab.ports), /conflicts/);
  await assert.rejects(lab.index().reserveManagedForward("shop", lab.request, lab.candidate, { ...lab.operator, reason: "A different purpose cannot rewrite the continuation audit" }, lab.ports), /conflicts/);
  assert.equal(lab.authorizations(), 1); assert.equal((await lab.readEnvelope()).fence?.nextAction, 5); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
});

test("invalid candidates and denied continuation authority cannot consume an action or change a held release", async (t) => {
  const lab = await fixture(t); const before = await readFile(lab.envelope, "utf8"); const resources = await lab.index().resourceSnapshot();
  await assert.rejects(lab.index().reserveManagedForward("shop", lab.request, { ...lab.candidate, commit: "f".repeat(40) }, lab.operator, lab.ports), /selected prepared build/);
  const db = lab.candidate.services["db"]; assert.ok(db);
  await assert.rejects(lab.index().reserveManagedForward("shop", lab.request, { ...lab.candidate, services: { ...lab.candidate.services, db: { ...db, command: ["upgrade-engine"] } } }, lab.operator, lab.ports), /retained dependency specification changed/);
  await assert.rejects(lab.index().reserveManagedForward("shop", lab.request, lab.candidate, lab.operator, { ...lab.ports, compare: () => Promise.resolve("changed") }), /retained dependency inputs changed/);
  lab.denyReservation(); await assert.rejects(lab.index().reserveManagedForward("shop", lab.request, lab.candidate, lab.operator, lab.ports), /current authority/);
  assert.equal(await readFile(lab.envelope, "utf8"), before); assert.deepEqual(await lab.index().resourceSnapshot(), resources); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
});

for (const when of ["before", "after"] as const) test(`forward reservation reconstructs a lost ${when} synchronization outcome without duplicate allocation`, async (t) => {
  const lab = await fixture(t); lab.cut(when === "before" ? "reservation-before" : "reservation-after");
  await assert.rejects(lab.index().reserveManagedForward("shop", lab.request, lab.candidate, lab.operator, lab.ports), /injected/);
  const committed = when === "after" ? (await lab.readEnvelope()).forward : undefined; await lab.reopen(); lab.clock(2000);
  const reservation = await lab.index().reserveManagedForward("shop", lab.request, lab.candidate, lab.operator, lab.ports); if (committed !== undefined) assert.deepEqual(reservation, committed);
  assert.equal((await lab.readEnvelope()).fence?.nextAction, 5); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
});
