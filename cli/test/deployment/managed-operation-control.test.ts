/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- observes native boundary calls and drives fixture settlement */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedIndexFixture } from "./managed-index-fixture.ts";
import { managedPreparation } from "../../src/server/deployment/managed-preparation.ts";
import { managedOperationControl } from "../../src/server/deployment/managed-operation-control.ts";
import { deploymentControl } from "../../src/server/deployment/deployment-control.ts";
import { managedReceipt } from "../../src/server/deployment/managed-receipt.ts";
import { parseManagedDeploymentReceipt } from "../../src/contracts/managed-deployment-receipt.ts";
import type { IndexedManagedRuntime } from "../../src/server/deployment/indexed-managed-lifecycle.ts";
import { typed } from "../../src/lib/typed.ts";

const fixture = async (t: TestContext) => {
  const lab = await managedIndexFixture(t); const calls: string[] = [];
  const runtime = typed<IndexedManagedRuntime>({ ...lab.runtime, managedData: { native: { observe: () => Promise.resolve({ status: "absent" }), create: () => Promise.reject(new Error("unexpected volume creation")) }, workloads: () => lab.runtime.services } });
  const preparation = managedPreparation(lab.index(), { builds: { ...lab.artifacts, now: lab.runtime.now, images: () => [], prepare: () => { calls.push("builder"); return Promise.reject(new Error("unexpected build")); } },
    inputs: { compare: () => Promise.resolve("unchanged") }, plans: { volumeKeys: () => Promise.resolve(lab.volumes.map((volume) => volume.key)), preview: () => Promise.resolve(lab.plan) }, runtime: () => Promise.resolve(runtime) });
  const ports = { ...lab.artifacts, now: lab.runtime.now, canAccess: () => Promise.resolve(true), prepare: preparation.prepare, restore: preparation.restore, forRun: () => { calls.push("runtime"); return Promise.resolve(runtime); } };
  return { ...lab, runtime, calls, ports, commands: () => managedOperationControl(lab.index(), ports) };
};

test("public managed commands return source-bound acceptance and cancellation receipts without leaking private records", async (t) => {
  const lab = await fixture(t); const run = randomUUID(); const input = { app: "shop", request: run, commit: lab.plan.commit };
  const control = () => deploymentControl({ index: lab.index(), now: lab.runtime.now, enabled: () => Promise.resolve(true), canAccess: () => Promise.resolve(true), managed: lab.commands() });
  const raw = await control()("/deployment/prepare", input); const receipt = parseManagedDeploymentReceipt(raw); assert.ok(receipt.ok); assert.equal(receipt.value.phase, "accepted"); assert.equal(receipt.value.request, run); assert.equal("source" in receipt.value, false); assert.equal("owner" in receipt.value, false);
  assert.deepEqual(await control()("/deployment/prepare", input), raw); assert.deepEqual(lab.calls, []); assert.equal(lab.hostCalls(), 0);
  const accepted = await lab.index().acceptedManagedRequest("shop", run, lab.runtime); assert.ok(accepted); assert.throws(() => managedReceipt({ ...accepted.source, run: randomUUID() }, accepted.request), /source binding/);
  assert.deepEqual(await control()("/deployment/cancel", { app: "shop", request: run }), raw); assert.deepEqual(lab.calls, ["runtime"]);
  assert.ok((await lab.index().managedState("shop", lab.runtime))?.operation.cancelRequestedAt);
  for (let i = 0; i < 12; i++) { const state = await lab.index().tickManagedDeployment("shop", run, lab.runtime); if (state?.operation.phase === "complete") break; }
  await lab.reopen(); lab.calls.length = 0;
  const complete = await lab.commands().cancel({ app: "shop", request: run }); assert.equal(complete.phase, "complete"); assert.equal(complete.disposition, "cancelled"); assert.equal(complete.deadline, receipt.value.deadline); assert.deepEqual(lab.calls, []);
});

test("managed run pages reconstruct accepted and terminal outcomes from owned records across restart", async (t) => {
  const lab = await fixture(t); const run = randomUUID(); const app = "shop";
  const control = () => deploymentControl({ index: lab.index(), now: lab.runtime.now, enabled: () => Promise.resolve(true),
    canAccess: (name) => Promise.resolve(name === app), managed: lab.commands(), artifacts: lab.artifacts });
  const report = (request?: string) => control()("/deployment/runs", request === undefined ? { app } : { app, request });
  assert.deepEqual(await report(), { app, protocol: "managed-v3", runs: [] });
  await lab.commands().prepare({ app, request: run, commit: lab.plan.commit });
  const accepted = await lab.index().publishedDeploymentRuns(app, run, lab.runtime);
  assert.deepEqual(accepted?.runs[0]?.managed, { protocol: "managed-v3", phase: "admitting", outcome: null, requiredAction: "none", activeRelease: null });
  assert.deepEqual(await report(run), accepted);
  assert.equal(accepted.runs[0].sha, lab.plan.commit);
  await lab.commands().cancel({ app, request: run });
  for (let i = 0; i < 12; i++) { const state = await lab.index().tickManagedDeployment(app, run, lab.runtime); if (state?.operation.phase === "complete") break; }
  await lab.reopen();
  const finished = await lab.index().publishedDeploymentRuns(app, run, lab.runtime);
  assert.deepEqual(finished?.runs[0]?.managed, { protocol: "managed-v3", phase: "complete", outcome: "absent", requiredAction: "none", activeRelease: null });
  assert.equal(finished.runs[0].state, "failure");
  assert.ok(finished.runs[0].finished);
  assert.deepEqual(await report(), finished);
  assert.deepEqual(await report(randomUUID()), { app, protocol: "managed-v3", runs: [] });
  await assert.rejects(control()("/deployment/runs", { app: "another" }), /outside deployment scope/);
  assert.equal(await control()("/deployment/runs", { app, request: "not-a-run" }), undefined);
  assert.equal(lab.hostCalls(), 0);
});

test("managed public prepare requires a retained build and never starts the builder inside the control request", async (t) => {
  const lab = await fixture(t);
  await assert.rejects(lab.commands().prepare({ app: "shop", request: randomUUID(), commit: "b".repeat(40) }), /requires a retained build/); assert.deepEqual(lab.calls, []); assert.deepEqual(await lab.index().pendingManagedDeployments(), []);
});

test("persisted managed protocol cannot fall back to legacy rollout ports or be selected by request fields", async (t) => {
  const lab = await fixture(t); const input = { app: "shop", request: randomUUID(), commit: lab.plan.commit };
  const control = deploymentControl({ index: lab.index(), now: lab.runtime.now, enabled: () => Promise.resolve(true), canAccess: () => Promise.resolve(true), plans: { now: lab.runtime.now, retain: lab.artifacts.retain, preview: () => Promise.reject(new Error("unexpected legacy compilation")) } });
  await assert.rejects(control("/deployment/prepare", input), /managed-v3 mutation dispatch is disabled/); await assert.rejects(control("/deployment/cancel", { app: "shop", request: input.request }), /managed-v3 mutation dispatch is disabled/);
  assert.equal(await control("/deployment/prepare", { ...input, protocol: "legacy" }), undefined); assert.deepEqual(lab.calls, []); assert.deepEqual(await lab.index().pendingManagedDeployments(), []);
  await assert.rejects(control("/deployment/restore", { app: "shop", request: input.request, record: "a".repeat(64) }), /restore is unavailable/);
});

test("managed restore refuses unknown history or a deployment request reused as a restore before reaching the builder", async (t) => {
  const lab = await fixture(t);
  const control = deploymentControl({ index: lab.index(), now: lab.runtime.now, enabled: () => Promise.resolve(true), canAccess: () => Promise.resolve(true), managed: lab.commands() });
  const request = randomUUID();
  assert.equal(await control("/deployment/restore", { app: "shop", request, record: lab.plan.commit }), undefined);
  const restore = { app: "shop", request, record: "a".repeat(64) };
  await assert.rejects(control("/deployment/restore", restore), /lacks verified release history/);
  assert.deepEqual(await lab.index().pendingManagedDeployments(), []);
  await lab.commands().prepare({ app: "shop", request, commit: lab.plan.commit });
  await assert.rejects(control("/deployment/restore", restore), /request identity conflicts/);
  assert.deepEqual(lab.calls, []);
});

test("scope and input validation precede all managed command state access", async (t) => {
  const lab = await fixture(t); const unreadable = { ...lab.index(), acceptedManagedRequest: () => Promise.reject(new Error("unexpected owner read")) }; const commands = managedOperationControl(unreadable, { ...lab.ports, canAccess: () => Promise.resolve(false) });
  await assert.rejects(commands.prepare({ app: "shop", request: randomUUID(), commit: lab.plan.commit }), /outside managed/); await assert.rejects(commands.cancel({ app: "shop", request: randomUUID() }), /outside managed/);
  await assert.rejects(commands.prepare({ app: "shop", request: randomUUID(), commit: lab.plan.commit, candidate: lab.plan }), /invalid deployment/); assert.deepEqual(lab.calls, []);
});

test("a cancellation runtime loader cannot dispatch after its bounded wait expires", async (t) => {
  const lab = await fixture(t); const run = randomUUID(); await lab.commands().prepare({ app: "shop", request: run, commit: lab.plan.commit });
  const entered = Promise.withResolvers<undefined>(); const loaded = Promise.withResolvers<IndexedManagedRuntime>(); t.mock.timers.enable({ apis: ["setTimeout"] });
  const commands = managedOperationControl(lab.index(), { ...lab.ports, forRun: () => { entered.resolve(undefined); return loaded.promise; } });
  const pending = assert.rejects(commands.cancel({ app: "shop", request: run }), /runtime unavailable/); await entered.promise; t.mock.timers.tick(10_001); await pending;
  loaded.resolve(lab.runtime); await Promise.resolve(); assert.equal((await lab.index().managedState("shop", lab.runtime))?.operation.cancelRequestedAt, null);
});
