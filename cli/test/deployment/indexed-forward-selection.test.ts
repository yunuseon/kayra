/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- drives an owned held lifecycle and reopens its real filesystem journals */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, stat, writeFile, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedIndexRuntimeFixture } from "./managed-index-runtime-fixture.ts";
import type { ManagedServiceAction } from "../../src/contracts/managed-swarm-service.ts";
import type { ServiceVersion } from "../../src/contracts/swarm-service.ts";
import { parseManagedRelease, managedReleaseBaselines } from "../../src/server/deployment/managed-release.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { parseLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index-state.ts";

const fixture = async (t: TestContext) => {
  let cut: "catalog-before" | "catalog-after" | "decision-after" | "publication-before" | "publication-after" | undefined; let decisions = 0;
  const journals = async (...args: Parameters<typeof openJournal>) => {
    const base = await openJournal(...args); return { ...base, write: async (value: Parameters<typeof base.write>[0]) => {
      const phase = typeof value === "object" && value !== null && "apps" in value ? parseLifecycleAppIndex(value).apps.find((item) => item.app === "shop")?.forwardSelections?.[0]?.phase : undefined;
      const point = phase === "initializing" ? "catalog" : phase === "ready" ? "publication" : args[0].includes("/managed/forward/") ? "decision" : undefined;
      if (point !== undefined && cut === point + "-before") { cut = undefined; throw new Error("injected before " + point); }
      await base.write(value); if (point === "decision") decisions++;
      if (point !== undefined && cut === point + "-after") { cut = undefined; throw new Error("injected after " + point); }
    } };
  };
  const lab = await managedIndexRuntimeFixture(t, false, journals);
  const runtime = { ...lab.runtime, services: { ...lab.runtime.services, tombstone: (action: ManagedServiceAction, expected: ServiceVersion | null) => {
    const before = lab.services.get(action.service); assert.ok(before); assert.equal(before.status, "owned"); assert.ok(expected); assert.equal(expected.id, before.id); assert.equal(expected.version, before.version);
    lab.services.set(action.service, { ...before, version: before.version + 1, action: action.action, effect: action.effect, taskEffect: "remove", plan: action.plan, tombstone: true, retainedInputsCleared: action.effect === "scrub", containersStopped: true, containersConverged: true, replicas: 0, endpoint: "dnsrr", update: "completed", tasks: [] }); return Promise.resolve("acknowledged" as const);
  } } };
  await lab.index().requestManagedDeployment("shop", lab.source, runtime);
  for (let i = 0; i < 100; i++) { const value = await lab.index().tickManagedDeployment("shop", lab.source.run, runtime); assert.notEqual(value?.operation.phase, "held"); if (value?.operation.phase === "complete") break; }
  const initial = await lab.index().managedState("shop", runtime); assert.ok(initial?.active); const previous = parseManagedRelease(JSON.parse(await lab.artifacts.read(initial.active.record)));
  const build = await lab.index().prepareBuild("shop", "b".repeat(40), { ...lab.artifacts, now: runtime.now, prepare: () => Promise.resolve(JSON.stringify({ commit: "b".repeat(40) })), images: () => lab.plan.images.map((image) => image.pull) });
  const candidate = parseManagedApplicationPlan({ ...lab.plan, commit: build.commit, artifact: build.artifact, grants: { ...lab.plan.grants, maintenance: true }, rollout: { ...lab.plan.rollout, strategy: "maintenance", rollback_compatible: false } }); assert.ok(candidate.ok);
  const retained = managedReleaseBaselines(previous).filter((item) => previous.source.application.services[item.name]?.role === "retained-dependency").map((item) => ({ ...item, kind: "active" as const }));
  const source = parseManagedLifecycleSource({ ...lab.source, candidate: candidate.value, previous, retained, run: randomUUID(), action: lab.incarnation + ":3" }); await lab.index().requestManagedDeployment("shop", source, runtime);
  for (let i = 0; i < 100; i++) { const state = await lab.index().tickManagedDeployment("shop", source.run, runtime); assert.notEqual(state?.operation.phase, "held"); if (state?.operation.phase === "verifying") break; }
  const ready = await lab.index().managedState("shop", runtime); assert.equal(ready?.operation.phase, "verifying"); await lab.index().cancelManagedDeployment("shop", source.run, runtime); const held = await lab.index().tickManagedDeployment("shop", source.run, runtime); assert.equal(held?.operation.phase, "held"); assert.ok(held.operation.compatibilityFencedAt);
  const request = { app: "shop", blockedRun: source.run, request: randomUUID(), commit: "e".repeat(40), reason: "Prepare an explicit forward fix after the maintenance failure" }; const actor = { kind: "operator-control", identity: "fixture-operator" } as const;
  let allowed = true; const ports = { ...lab.artifacts, now: lab.runtime.now, authorize: () => Promise.resolve(allowed) };
  return { ...lab, runtime, source, held, request, actor, ports, cut: (point: typeof cut) => { cut = point; }, decisions: () => decisions, deny: () => { allowed = false; }, selectionDirectory: join(lab.directory, createHash("sha256").update("shop").digest("hex"), "managed", "forward", request.request) };
};

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
