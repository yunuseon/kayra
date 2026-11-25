/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- accepts test context, counts fixture boundary calls and injects lost acknowledgements */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedIndexRuntimeFixture } from "./managed-index-runtime-fixture.ts";
import { parseLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index-state.ts";
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

test("a pending managed operation refuses legacy build entrypoints before creating another build intent or invoking the builder", async (t) => {
  const lab = await fixture(t); const run = randomUUID();
  const receipt = await managedPreparation(lab.index(), lab.ports).prepare("shop", run, "b".repeat(40)); lab.calls.length = 0;
  const before = await readFile(join(lab.directory, "state.json"), "utf8");
  await assert.rejects(lab.index().prepareBuild("shop", "c".repeat(40), lab.ports.builds), /managed build.*unresolved/); assert.deepEqual(lab.calls, []); assert.equal(await readFile(join(lab.directory, "state.json"), "utf8"), before);
  assert.deepEqual(await managedPreparation(lab.index(), lab.ports).prepare("shop", run, "b".repeat(40)), receipt); assert.deepEqual(lab.calls, ["runtime"]);
  lab.clock(receipt.admissionDeadline + 1);
  for (let i = 0; i < 12; i++) { const state = await lab.index().tickManagedDeployment("shop", run, lab.runtime); if (state?.operation.phase === "complete") break; }
  const complete = await lab.index().managedRequestSource("shop", run, "b".repeat(40), lab.runtime); assert.ok(complete?.request.completion); lab.calls.length = 0;
  const build = await lab.index().prepareBuild("shop", "c".repeat(40), lab.ports.builds); assert.equal(build.commit, "c".repeat(40)); assert.deepEqual(lab.calls, ["builder"]);
});

test("managed builds release the app writer while preparing and deduplicate the same immutable build", { timeout: 10000 }, async (t) => {
  const lab = await fixture(t); const entered = Promise.withResolvers<undefined>(); const output = Promise.withResolvers<string>(); let builds = 0;
  const ports = { ...lab.ports.builds, prepare: () => { builds++; entered.resolve(undefined); return output.promise; } };
  const first = lab.index().prepareBuild("shop", "c".repeat(40), ports); await entered.promise;
  const second = lab.index().prepareBuild("shop", "c".repeat(40), ports);
  try {
    assert.equal((await lab.index().verifiedRegistration("shop")).app, "shop");
    await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime);
    await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime);
    await lab.index().cancelManagedDeployment("shop", lab.source.run, lab.runtime);
    for (let i = 0; i < 8; i++) { const value = await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); if (value?.operation.phase === "complete") break; }
    assert.equal((await lab.index().managedState("shop", lab.runtime))?.operation.outcome, "absent"); assert.equal(builds, 1);
  } finally { output.resolve(JSON.stringify({ commit: "c".repeat(40) })); }
  const [a, b] = await Promise.all([first, second]); assert.deepEqual(a, b); assert.equal(builds, 1); assert.equal(a.deadline, 1000 + 45 * 60000);
  assert.equal((await lab.index().managedState("shop", lab.runtime))?.active, null);
});

test("closing the managed build owner aborts an unresponsive builder and late output cannot publish a receipt", { timeout: 10000 }, async (t) => {
  const lab = await fixture(t); const entered = Promise.withResolvers<undefined>(); const output = Promise.withResolvers<string>(); const aborted: boolean[] = [];
  // Use the public port type to observe its cancellation signal even though this builder ignores cancellation.
  const build = lab.index().prepareBuild("shop", "c".repeat(40), { ...lab.ports.builds, prepare: (_registration, _commit, _deadline, signal) => { signal.addEventListener("abort", () => { aborted.push(true); }, { once: true }); entered.resolve(undefined); return output.promise; } });
  const rejected = assert.rejects(build, /owner closed/); await entered.promise; await lab.reopen(); await rejected; assert.deepEqual(aborted, [true]);
  const before = await readFile(join(lab.directory, "state.json"), "utf8"); output.resolve(JSON.stringify({ commit: "c".repeat(40) })); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await readFile(join(lab.directory, "state.json"), "utf8"), before);
  const state = parseLifecycleAppIndex(JSON.parse(before));
  const pending = state.builds.find((value) => value.commit === "c".repeat(40)); assert.ok(pending); assert.equal(pending.artifact, null);
  const retry = await lab.index().prepareBuild("shop", "c".repeat(40), lab.ports.builds); assert.equal(retry.deadline, pending.deadline);
});

test("different managed commits keep their builder queue without blocking the coordinator or renewing queued deadlines", { timeout: 10000 }, async (t) => {
  const lab = await fixture(t); const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<string>(); const commits: string[] = [];
  const ports = { ...lab.ports.builds, prepare: (_registration: unknown, commit: string) => { commits.push(commit); if (commit === "c".repeat(40)) { entered.resolve(undefined); return release.promise; } return Promise.resolve(JSON.stringify({ commit })); } };
  const first = lab.index().prepareBuild("shop", "c".repeat(40), ports); await entered.promise;
  lab.clock(2000); const second = lab.index().prepareBuild("shop", "e".repeat(40), ports);
  try { await lab.index().verifiedRegistration("shop"); await lab.index().verifiedRegistration("shop"); assert.deepEqual(commits, ["c".repeat(40)]); lab.clock(3000); }
  finally { release.resolve(JSON.stringify({ commit: "c".repeat(40) })); }
  const [a, b] = await Promise.all([first, second]); assert.deepEqual(commits, ["c".repeat(40), "e".repeat(40)]); assert.equal(a.deadline, 1000 + 45 * 60000); assert.equal(b.deadline, 2000 + 45 * 60000);
});

test("expired managed build intents survive restart without another builder call or scheduling window", async (t) => {
  const lab = await fixture(t); const entered = Promise.withResolvers<undefined>(); const output = Promise.withResolvers<string>();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const build = lab.index().prepareBuild("shop", "c".repeat(40), { ...lab.ports.builds, prepare: () => { entered.resolve(undefined); return output.promise; } });
  const rejected = assert.rejects(build, /deadline expired/); await entered.promise; lab.clock(1000 + 45 * 60000); t.mock.timers.tick(45 * 60000); await rejected; await lab.reopen();
  lab.calls.length = 0; await assert.rejects(lab.index().prepareBuild("shop", "c".repeat(40), lab.ports.builds), /original deadline expired/); assert.deepEqual(lab.calls, []);
  output.resolve("late output");
});
