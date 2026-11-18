/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- accepts test context, counts fixture boundary calls and injects lost acknowledgements */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedIndexRuntimeFixture } from "./managed-index-runtime-fixture.ts";
import { managedPreparation } from "../../src/server/deployment/managed-preparation.ts";
import type { IndexedManagedRuntime } from "../../src/server/deployment/indexed-managed-lifecycle.ts";
import type { OwnedVolumePort } from "../../src/contracts/owned-volume.ts";
import { typed } from "../../src/lib/typed.ts";

const fixture = async (t: TestContext) => {
  const lab = await managedIndexRuntimeFixture(t); const calls: string[] = [];
  const native = typed<Readonly<Pick<OwnedVolumePort, "observe" | "create">>>({ observe: (volume) => Promise.resolve({ status: "owned", receipt: { volume, createdAt: new Date(1000).toISOString() } }), create: () => Promise.resolve("refused") });
  const runtime = typed<IndexedManagedRuntime>({ ...lab.runtime, managedData: { native, workloads: () => lab.runtime.services } });
  const ports = {
    builds: { ...lab.artifacts, now: lab.runtime.now, prepare: (_registration: unknown, commit: string) => { calls.push("builder"); return Promise.resolve(JSON.stringify({ commit })); }, images: () => lab.plan.images.map((image) => image.pull) },
    plans: {
      volumeKeys: () => { calls.push("keys"); return Promise.resolve(["database"]); },
      preview: (_registration: unknown, commit: string, artifact: string) => { calls.push("compiler"); return Promise.resolve({ ...lab.source.candidate, commit, artifact }); },
    },
    inputs: { compare: () => Promise.resolve("unchanged" as const) },
    runtime: async (context: { readonly run: string; readonly allocationRequired: boolean }) => { calls.push("runtime"); assert.equal(context.allocationRequired, true); await lab.index().pendingManagedDeployments(); return runtime; },
  };
  return { ...lab, calls, ports };
};

test("managed preparation connects immutable build, compilation and indexed acceptance without runtime effects", async (t) => {
  const lab = await fixture(t); const run = randomUUID(); const commit = "b".repeat(40);
  const receipt = await managedPreparation(lab.index(), lab.ports).prepare("shop", run, commit);
  assert.equal(receipt.run, run); assert.equal(receipt.completion, null); assert.deepEqual(lab.calls, ["builder", "keys", "compiler", "runtime"]);
  assert.equal(lab.hostCalls(), 0); assert.equal(lab.services.size, 0); assert.equal(lab.jobs.size, 0);
  const context = await lab.index().managedExecutionContext("shop", run, lab.runtime); assert.ok(context); assert.equal(context.application.commit, commit); assert.equal(context.action, lab.incarnation + ":2");
  assert.deepEqual(await lab.index().managedHealthContexts(lab.runtime), [context]);
  await assert.rejects(managedPreparation(lab.index(), lab.ports).prepare("shop", randomUUID(), "c".repeat(40)), /unresolved/); assert.equal(lab.calls.length, 4);
});

test("lost acceptance acknowledgement resumes the original source and deadlines before builder or compiler access", async (t) => {
  const lab = await fixture(t); const run = randomUUID(); const commit = "b".repeat(40); const index = lab.index();
  const owner = managedPreparation({ ...index, requestManagedDeployment: async (...args: Readonly<Parameters<typeof index.requestManagedDeployment>>) => { await index.requestManagedDeployment(...args); throw new Error("lost acceptance acknowledgement"); } }, lab.ports);
  const recovered = await owner.prepare("shop", run, commit); assert.equal(recovered.run, run); assert.equal(recovered.completion, null);
  const before = await index.managedExecutionContext("shop", run, lab.runtime); assert.ok(before); await lab.reopen(); lab.clock(before.admissionDeadline + 1); lab.calls.length = 0;
  const receipt = await managedPreparation(lab.index(), lab.ports).prepare("shop", run, commit);
  assert.equal(receipt.createdAt, before.createdAt); assert.equal(receipt.admissionDeadline, before.admissionDeadline); assert.equal(receipt.deadline, before.deadline); assert.deepEqual(lab.calls, ["runtime"]);
  await assert.rejects(managedPreparation(lab.index(), lab.ports).prepare("shop", run, "c".repeat(40)), /identity conflicts/); assert.deepEqual(lab.calls, ["runtime"]);
});

test("a compiler cannot replace the commit or bundle receipt before acceptance", async (t) => {
  const lab = await fixture(t); const run = randomUUID();
  await assert.rejects(managedPreparation(lab.index(), { ...lab.ports, plans: { ...lab.ports.plans, preview: () => Promise.resolve(lab.plan) } }).prepare("shop", run, "b".repeat(40)), /compiler changed/);
  assert.deepEqual(await lab.index().pendingManagedDeployments(), []); assert.equal(lab.calls.includes("runtime"), false); assert.equal(lab.hostCalls(), 0);
});

test("invalid identities fail before immutable build preparation", async (t) => {
  const lab = await fixture(t); const owner = managedPreparation(lab.index(), lab.ports);
  await assert.rejects(owner.prepare("shop", "invalid", "b".repeat(40)), /exact commit/); await assert.rejects(owner.prepare("shop", randomUUID(), "main"), /exact commit/); assert.deepEqual(lab.calls, []);
});

test("an unavailable runtime times out without acceptance and a late factory result cannot dispatch", async (t) => {
  const lab = await fixture(t); const entered = Promise.withResolvers<undefined>(); const result = Promise.withResolvers<IndexedManagedRuntime>();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = managedPreparation(lab.index(), { ...lab.ports, runtime: () => { entered.resolve(undefined); return result.promise; } }).prepare("shop", randomUUID(), "b".repeat(40));
  const rejected = assert.rejects(pending, /input deadline/); await entered.promise; t.mock.timers.tick(10_001); await rejected;
  result.resolve(lab.runtime); await Promise.resolve(); assert.deepEqual(await lab.index().pendingManagedDeployments(), []); assert.equal(lab.hostCalls(), 0); assert.equal(lab.services.size, 0);
});

test("completed retries return their original receipt without starting runtime composition", async (t) => {
  const lab = await fixture(t); const run = randomUUID(); const commit = "b".repeat(40);
  const receipt = await managedPreparation(lab.index(), lab.ports).prepare("shop", run, commit); lab.clock(receipt.admissionDeadline + 1);
  for (let i = 0; i < 12; i++) { const state = await lab.index().tickManagedDeployment("shop", run, lab.runtime); if (state?.operation.phase === "complete") break; }
  const completed = await lab.index().managedRequestSource("shop", run, commit, lab.runtime); assert.ok(completed?.request.completion); await lab.reopen(); lab.calls.length = 0;
  assert.equal(await lab.index().managedExecutionContext("shop", run, lab.runtime), undefined); assert.equal((await lab.index().managedHealthContexts(lab.runtime))[0]?.run, run);
  assert.deepEqual(await managedPreparation(lab.index(), lab.ports).prepare("shop", run, commit), completed.request); assert.deepEqual(lab.calls, []);
});

test("concurrent preparations with different proposal timestamps return the one accepted request", async (t) => {
  const lab = await fixture(t); const run = randomUUID(); const commit = "b".repeat(40); const ready = Promise.withResolvers<undefined>(); const contexts: { readonly createdAt: number }[] = [];
  const owner = managedPreparation(lab.index(), { ...lab.ports, runtime: async (context) => {
    contexts.push(context); lab.clock(2000); if (contexts.length === 2) ready.resolve(undefined); await ready.promise; return lab.ports.runtime(context);
  } });
  const receipts = await Promise.all([owner.prepare("shop", run, commit), owner.prepare("shop", run, commit)]);
  assert.equal(contexts.length, 2); assert.notEqual(contexts[0]?.createdAt, contexts[1]?.createdAt); assert.deepEqual(receipts[0], receipts[1]); assert.equal((await lab.index().pendingManagedDeployments()).length, 1);
});
