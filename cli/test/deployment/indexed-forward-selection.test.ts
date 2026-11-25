import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile, rename, stat, writeFile, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { indexedForwardFixture as fixture } from "./indexed-forward-fixture.ts";
import { parseLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index-state.ts";

test("the app index durably binds forward decisions before issuing isolated build permission without settling the held run", async (t) => {
  const lab = await fixture(t); const resources = await lab.index().resourceSnapshot();
  await assert.rejects(lab.index().managedForwardBuildGrant("shop", lab.request, lab.ports), /not durably published/);
  const chosen = await lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports); assert.equal(chosen.audit.request.commit, lab.request.commit);
  const state = parseLifecycleAppIndex(JSON.parse(await readFile(join(lab.directory, "state.json"), "utf8"))); const entry = state.apps.find((item) => item.app === "shop"); assert.equal(entry?.forwardSelections?.[0]?.phase, "ready"); assert.equal(entry.forwardSelections[0].decision, chosen.id);
  const catalog = entry.forwardSelections[0]; assert.ok(catalog);
  for (const invalid of [{ ...catalog, phase: "initializing" }, { ...catalog, request: catalog.blockedRun }, { ...catalog, registration: { ...catalog.registration, app: "other" } }]) assert.throws(() => parseLifecycleAppIndex({ ...state, apps: state.apps.map((value) => value.app === "shop" ? { ...value, forwardSelections: [invalid] } : value) }));
  assert.throws(() => parseLifecycleAppIndex({ ...state, apps: state.apps.map((value) => value.app === "shop" ? { ...value, forwardSelections: [catalog, catalog] } : value) }));
  const grant = await lab.index().managedForwardBuildGrant("shop", lab.request, lab.ports); assert.equal(grant?.selection, chosen.id); assert.equal(grant.deadline, chosen.audit.buildDeadline);
  await lab.reopen(); assert.deepEqual(await lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports), chosen); assert.deepEqual(await lab.index().managedForwardBuildGrant("shop", lab.request, lab.ports), grant);
  assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held); assert.deepEqual(await lab.index().resourceSnapshot(), resources);
  lab.deny(); assert.equal(await lab.index().managedForwardBuildGrant("shop", lab.request, lab.ports), undefined); assert.deepEqual(await lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports), chosen);
  await assert.rejects(lab.index().selectManagedForward("shop", { ...lab.request, commit: "f".repeat(40) }, lab.actor, lab.ports), /conflicts/);
  await assert.rejects(lab.index().managedForwardBuildGrant("shop", { ...lab.request, commit: "f".repeat(40) }, lab.ports), /binding disagrees/);
});

test("a published forward decision never recreates its missing private journal and historical replay needs no mutable root", async (t) => {
  const lab = await fixture(t); const chosen = await lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports); const file = join(lab.selectionDirectory, "state.json"); await rename(file, file + ".kept");
  try { await assert.rejects(lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports), /missing or invalid/); await assert.rejects(stat(file), { code: "ENOENT" }); } finally { await rename(file + ".kept", file); }
  const root = join(lab.selectionDirectory, "..", "..", "state.json"); await rename(root, root + ".kept");
  try { assert.deepEqual(await lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports), chosen); assert.equal(await lab.index().managedForwardBuildGrant("shop", lab.request, lab.ports), undefined); await assert.rejects(stat(root), { code: "ENOENT" }); } finally { await rename(root + ".kept", root); }
  const parent = join(lab.selectionDirectory, "..", ".."); await rename(parent, parent + ".kept"); await symlink(parent + ".kept", parent);
  try { await assert.rejects(lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports), /directory/); } finally { await unlink(parent); await rename(parent + ".kept", parent); }
  lab.clock(chosen.audit.buildDeadline); await lab.reopen(); assert.deepEqual(await lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports), chosen); assert.equal(await lab.index().managedForwardBuildGrant("shop", lab.request, lab.ports), undefined);
});


for (const point of ["catalog-before", "catalog-after", "decision-after", "publication-before", "publication-after"] as const) test(`indexed forward selection reconstructs ${point} interruption without another decision or capacity settlement`, async (t) => {
  const lab = await fixture(t); const resources = await lab.index().resourceSnapshot(); lab.cut(point);
  await assert.rejects(lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports), /injected|uncertain/);
  await lab.reopen(); if (point !== "catalog-before") lab.clock(2000);
  const chosen = await lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports); assert.equal(chosen.audit.createdAt, 1000); assert.equal(chosen.audit.buildDeadline, 1000 + 45 * 60000); assert.equal(lab.decisions(), 1);
  const grant = await lab.index().managedForwardBuildGrant("shop", lab.request, lab.ports); assert.equal(grant?.selection, chosen.id); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held); assert.deepEqual(await lab.index().resourceSnapshot(), resources);
});


test("a decision journal cannot substitute another indexed selection and wrong blocked runs create no intent", async (t) => {
  const lab = await fixture(t); const before = await readFile(join(lab.directory, "state.json"), "utf8");
  await assert.rejects(lab.index().selectManagedForward("shop", { ...lab.request, blockedRun: randomUUID() }, lab.actor, lab.ports), /pending lifecycle request/); assert.equal(await readFile(join(lab.directory, "state.json"), "utf8"), before);
  await lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports);
  const other = { ...lab.request, request: randomUUID(), commit: "f".repeat(40) }; await lab.index().selectManagedForward("shop", other, lab.actor, lab.ports);
  const first = join(lab.selectionDirectory, "state.json"); const original = await readFile(first, "utf8"); const substitute = await readFile(join(lab.selectionDirectory, "..", other.request, "state.json"), "utf8"); await writeFile(first, substitute);
  try { await assert.rejects(lab.index().managedForwardBuildGrant("shop", lab.request, lab.ports), /binding disagrees/); } finally { await writeFile(first, original); }
  assert.ok(await lab.index().managedForwardBuildGrant("shop", lab.request, lab.ports)); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
});


test("denied forward selection leaves the app index and private journal namespace unchanged", async (t) => {
  const lab = await fixture(t); const before = await readFile(join(lab.directory, "state.json"), "utf8"); lab.deny();
  await assert.rejects(lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports), /operator authority unavailable/); assert.equal(await readFile(join(lab.directory, "state.json"), "utf8"), before); await assert.rejects(stat(lab.selectionDirectory), { code: "ENOENT" }); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
});
