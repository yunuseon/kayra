/* eslint-disable functional/no-let, functional/prefer-immutable-types -- models builder waits, policy revocation, lost replies and restart */
import { strict as assert } from "node:assert";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { BuildPorts } from "../../src/contracts/build-artifact.ts";
import { parseLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index-state.ts";
import { indexedForwardFixture } from "./indexed-forward-fixture.ts";

const portsFor = (lab: Awaited<ReturnType<typeof indexedForwardFixture>>, prepare: BuildPorts["prepare"]) => ({ ...lab.artifacts, now: lab.runtime.now, authorizeSelection: lab.ports.authorize, prepare,
  images: (bytes: string, _registration: unknown, commit: string) => { const value: unknown = JSON.parse(bytes); assert.ok(typeof value === "object" && value !== null && "commit" in value); assert.equal(value.commit, commit); return lab.plan.images.map((image) => image.pull); },
});

test("a selected forward build is isolated, durably linked and replayable after expiry without a mutable root or another build", async (t) => {
  const lab = await indexedForwardFixture(t); const chosen = await lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports); const resources = await lab.index().resourceSnapshot(); let calls = 0;
  const ports = portsFor(lab, (registration, commit, deadline, _signal, runtime) => { calls++; assert.deepEqual(Object.keys(registration).sort(), ["actionId", "app", "incarnation", "registrationGeneration", "version"]); assert.equal(commit, lab.request.commit); assert.equal(deadline, chosen.audit.buildDeadline); assert.equal(runtime, "swarm"); return Promise.resolve(JSON.stringify({ commit })); });
  await assert.rejects(lab.index().prepareBuild("shop", lab.request.commit, ports), /blocked while a deployment is unresolved/);
  const result = await lab.index().prepareManagedForwardBuild("shop", lab.request, ports); assert.equal(result.selection, chosen.id); assert.equal(result.request, lab.request.request); assert.equal(result.build.commit, lab.request.commit); assert.equal(result.build.deadline, chosen.audit.buildDeadline); assert.equal(calls, 1);
  const state = parseLifecycleAppIndex(JSON.parse(await readFile(join(lab.directory, "state.json"), "utf8"))); assert.deepEqual(state.apps.find((item) => item.app === "shop")?.forwardSelections?.[0]?.preparedBuild, { id: result.build.id, artifact: result.build.artifact, deadline: result.build.deadline });
  const owner = state.apps.find((item) => item.app === "shop"); const record = owner?.forwardSelections?.[0]; assert.ok(record?.preparedBuild);
  for (const proof of [{ ...record.preparedBuild, artifact: "f".repeat(64) }, { ...record.preparedBuild, deadline: record.preparedBuild.deadline + 1 }]) assert.throws(() => parseLifecycleAppIndex({ ...state, apps: state.apps.map((item) => item.app === "shop" ? { ...item, forwardSelections: [{ ...record, preparedBuild: proof }] } : item) }), /forward build receipt disagrees/);
  assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held); assert.deepEqual(await lab.index().resourceSnapshot(), resources);
  await lab.reopen(); lab.clock(chosen.audit.buildDeadline + 1); lab.deny(); const root = join(lab.selectionDirectory, "..", "..", "state.json"); await rename(root, root + ".kept");
  try { assert.deepEqual(await lab.index().prepareManagedForwardBuild("shop", lab.request, { ...ports, prepare: () => Promise.reject(new Error("unexpected rebuild")), authorizeSelection: () => Promise.reject(new Error("unexpected new authority")) }), result); } finally { await rename(root + ".kept", root); }
  assert.equal(calls, 1); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
});

test("revoked permission during a forward build cannot publish a receipt and restart keeps the original build window", async (t) => {
  const lab = await indexedForwardFixture(t); const chosen = await lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports); const entered = Promise.withResolvers<undefined>(); const output = Promise.withResolvers<string>(); let calls = 0;
  const ports = portsFor(lab, () => { calls++; entered.resolve(undefined); return output.promise; }); const build = lab.index().prepareManagedForwardBuild("shop", lab.request, ports); const rejected = assert.rejects(build, /permission changed/); await entered.promise;
  assert.deepEqual(await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime), lab.held); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held); lab.deny(); output.resolve(JSON.stringify({ commit: lab.request.commit })); await rejected;
  const state = parseLifecycleAppIndex(JSON.parse(await readFile(join(lab.directory, "state.json"), "utf8"))); assert.equal(state.apps.find((item) => item.app === "shop")?.forwardSelections?.[0]?.preparedBuild, undefined); assert.equal(state.builds.find((item) => item.commit === lab.request.commit)?.artifact, null);
  await lab.reopen(); lab.clock(2000); lab.allow(); const result = await lab.index().prepareManagedForwardBuild("shop", lab.request, portsFor(lab, (_registration, commit, deadline) => { calls++; assert.equal(deadline, chosen.audit.buildDeadline); return Promise.resolve(JSON.stringify({ commit })); })); assert.equal(calls, 2); assert.equal(result.build.deadline, chosen.audit.buildDeadline); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
});

for (const point of ["build-publication-before", "build-publication-after"] as const) test(`forward build ${point} interruption reconstructs the durable result without renewing authority`, async (t) => {
  const lab = await indexedForwardFixture(t); const chosen = await lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports); let calls = 0;
  const ports = portsFor(lab, (_registration, commit, deadline) => { calls++; assert.equal(deadline, chosen.audit.buildDeadline); return Promise.resolve(JSON.stringify({ commit })); }); lab.cut(point);
  await assert.rejects(lab.index().prepareManagedForwardBuild("shop", lab.request, ports), /injected/); await lab.reopen(); lab.clock(point === "build-publication-after" ? chosen.audit.buildDeadline + 1 : 2000);
  const result = await lab.index().prepareManagedForwardBuild("shop", lab.request, ports); assert.equal(result.selection, chosen.id); assert.equal(result.build.deadline, chosen.audit.buildDeadline); assert.equal(calls, point === "build-publication-after" ? 1 : 2); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
});

test("bounded forward permission checks never abandon an asynchronously acquired root journal handle", async (t) => {
  const lab = await indexedForwardFixture(t); const chosen = await lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports); const gate = lab.pauseRootOpen(); t.mock.timers.enable({ apis: ["setTimeout"] }); let settled = false;
  const pending = lab.index().managedForwardBuildGrant("shop", lab.request, lab.ports); void pending.then(() => { settled = true; }, () => { settled = true; }); await gate.entered;
  try { t.mock.timers.tick(10001); await new Promise((resolve) => setImmediate(resolve)); assert.equal(settled, false); } finally { gate.release(); }
  assert.equal((await pending)?.selection, chosen.id); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
});


test("missing selection evidence during a forward build prevents publication and cannot be repaired by the builder", async (t) => {
  const lab = await indexedForwardFixture(t); await lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports); const entered = Promise.withResolvers<undefined>(); const output = Promise.withResolvers<string>();
  const ports = portsFor(lab, () => { entered.resolve(undefined); return output.promise; }); const pending = lab.index().prepareManagedForwardBuild("shop", lab.request, ports); const rejected = assert.rejects(pending, /missing or invalid/); await entered.promise;
  const before = await readFile(join(lab.directory, "state.json"), "utf8"); const file = join(lab.selectionDirectory, "state.json"); await rename(file, file + ".kept");
  try { output.resolve(JSON.stringify({ commit: lab.request.commit })); await rejected; assert.equal(await readFile(join(lab.directory, "state.json"), "utf8"), before); } finally { await rename(file + ".kept", file); }
  assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
});

test("closing a forward builder cancels its wait and late output cannot write through a reopened owner", async (t) => {
  const lab = await indexedForwardFixture(t); const chosen = await lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports); const entered = Promise.withResolvers<undefined>(); const output = Promise.withResolvers<string>(); let aborted = false;
  const ports = portsFor(lab, (_registration, _commit, _deadline, signal) => { signal.addEventListener("abort", () => { aborted = true; }, { once: true }); entered.resolve(undefined); return output.promise; });
  const pending = lab.index().prepareManagedForwardBuild("shop", lab.request, ports); const rejected = assert.rejects(pending, /owner closed/); await entered.promise; await lab.reopen(); await rejected; assert.equal(aborted, true);
  const before = await readFile(join(lab.directory, "state.json"), "utf8"); output.resolve(JSON.stringify({ commit: lab.request.commit })); await new Promise((resolve) => setImmediate(resolve)); assert.equal(await readFile(join(lab.directory, "state.json"), "utf8"), before);
  const result = await lab.index().prepareManagedForwardBuild("shop", lab.request, portsFor(lab, (_registration, commit, deadline) => { assert.equal(deadline, chosen.audit.buildDeadline); return Promise.resolve(JSON.stringify({ commit })); })); assert.equal(result.build.deadline, chosen.audit.buildDeadline); assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
});
