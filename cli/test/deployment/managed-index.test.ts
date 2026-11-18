import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { managedIndexFixture } from "./managed-index-fixture.ts";
import { parseLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index-state.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { reserveResources } from "../../src/server/deployment/resource-book.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";

const saved = async (directory: string) => { const raw: unknown = JSON.parse(await readFile(join(directory, "state.json"), "utf8")); return parseLifecycleAppIndex(raw); };
const key = (app: string) => createHash("sha256").update(app).digest("hex");

test("indexed managed admission shares one durable book and completes its existing lifecycle gate after restart", async (t) => {
  const lab = await managedIndexFixture(t); const request = await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime); assert.equal(request.action, lab.source.action);
  assert.deepEqual(await lab.index().pendingManagedDeployments(), [{ app: "shop", run: lab.source.run }]); assert.equal(lab.hostCalls(), 0);
  const pending = await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); assert.equal(pending?.operation.phase, "admitting"); assert.equal((await lab.index().resourceSnapshot())?.charges[0]?.result, "pending"); assert.equal(lab.hostCalls(), 1);
  await lab.reopen(); assert.deepEqual(await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime), request); assert.equal(lab.hostCalls(), 1);
  const bound = await saved(lab.directory); assert.equal(bound.managedBindings?.[0]?.source, request.source); assert.equal(bound.apps[0]?.managedRoot, "ready");
  await lab.index().cancelManagedDeployment("shop", lab.source.run, lab.runtime); await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); await lab.reopen();
  const done = await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); assert.equal(done?.operation.phase, "complete"); assert.equal(done.operation.outcome, "absent"); assert.equal(done.active, null); assert.equal((await lab.index().resourceSnapshot())?.charges[0]?.result, "absent"); assert.deepEqual(await lab.index().pendingManagedDeployments(), []);
  const receipt = await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime); assert.equal(receipt.completion?.disposition, "cancelled"); assert.equal(lab.hostCalls(), 1);
});

test("managed protocol persists while legacy queues and Compose registrations keep their implementation", async (t) => {
  const lab = await managedIndexFixture(t); const legacy = await lab.index().prepareApp("legacy"); const generation = randomUUID(); const ticket = await lab.index().reserveRegistration("legacy", generation, "compose"); await lab.index().submitRegistration("legacy", ticket, generation); await lab.index().reconcileRegistration("legacy", ticket, generation);
  await lab.reopen(); assert.equal(await lab.index().prepareApp("shop"), lab.incarnation); assert.equal(await lab.index().prepareApp("legacy"), legacy);
  await assert.rejects(lab.index().prepareApp("legacy", "managed-v3"), /conversion/); await assert.rejects(lab.index().reserveRegistration("shop", undefined, "compose"), /requires Swarm/);
  await assert.rejects(lab.index().deploymentStatus("shop"), /legacy deployment commands/); assert.equal((await lab.index().registrationPolicy("legacy")).runtime, "compose");
  assert.deepEqual(await lab.index().pendingHttpOperations(), []); assert.deepEqual(await lab.index().pendingRolloutOperations(), []); await assert.rejects(lab.index().runtimeHealthSnapshot(undefined), /managed-v3 runtime health/);
  const state = await saved(lab.directory); assert.equal(state.apps.find((item) => item.app === "legacy")?.protocol, undefined); assert.equal(state.apps.find((item) => item.app === "shop")?.protocol, "managed-v3");
});

test("preflight refusal and competing requests cannot strand a newly issued gate or replace an accepted source", async (t) => {
  const lab = await managedIndexFixture(t); const unknownRestore = parseManagedLifecycleSource({ ...lab.source, restore: "a".repeat(64) }); await assert.rejects(lab.index().requestManagedDeployment("shop", unknownRestore, lab.runtime), /preflight/);
  assert.deepEqual(await lab.index().pendingManagedDeployments(), []); assert.equal(await lab.index().managedState("shop", lab.runtime), undefined);
  const competing = parseManagedLifecycleSource({ ...lab.source, run: randomUUID(), action: lab.incarnation + ":3" });
  const results = await Promise.allSettled([lab.index().requestManagedDeployment("shop", lab.source, lab.runtime), lab.index().requestManagedDeployment("shop", competing, lab.runtime)]); assert.equal(results.filter((value) => value.status === "fulfilled").length, 1);
  assert.deepEqual(await lab.index().pendingManagedDeployments(), [{ app: "shop", run: lab.source.run }]); assert.equal(lab.hostCalls(), 0);
});

test("expired or revoked accepted requests close metadata without a fresh admission window", async (t) => {
  const lab = await managedIndexFixture(t); const request = await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime); lab.clock(request.deadline + 1000); lab.deny(); await lab.reopen();
  await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime);
  const done = await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); assert.equal(done?.operation.phase, "complete"); assert.equal(done.operation.deadline, request.deadline); assert.equal(done.operation.admitted, false); assert.equal(lab.hostCalls(), 0); assert.equal((await lab.index().resourceSnapshot())?.charges[0]?.result, "absent");
});

test("legacy peak charges consume the same capacity and survive failed managed admission unchanged", async (t) => {
  const lab = await managedIndexFixture(t); const incarnation = await lab.index().prepareApp("legacy"); const host = lab.plan.host; const budget = { cpu: host.profile.cpu_millicores - host.profile.platform_cpu_millicores, memory: 33554432 };
  const observation = await lab.runtime.observeHost(host); const old = reserveResources(null, host, observation, { app: "legacy", incarnation, sequence: 2, previous: null, target: { plan: "f".repeat(64), budget }, peak: budget, deadline: 91000, result: "pending" }, 1000); assert.ok(old.ok);
  await lab.index().close(); const journal = await openJournal(lab.directory, "existing"); try { const state = parseLifecycleAppIndex(await journal.read()); await journal.write({ ...state, resources: old.value }); } finally { await journal.close(); } await lab.reopen();
  await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime); const refused = await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); assert.equal(refused?.operation.phase, "held"); assert.equal(refused.operation.reason, "admission");
  await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); const done = await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); assert.equal(done?.operation.phase, "complete");
  const book = await lab.index().resourceSnapshot(); assert.deepEqual(book?.charges.find((item) => item.app === "legacy"), old.value.charges[0]); assert.equal(book?.charges.find((item) => item.app === "shop")?.result, "absent");
});

test("a known initialized managed journal is never recreated after its directory disappears", async (t) => {
  const lab = await managedIndexFixture(t); await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime); await lab.index().close(); const directory = join(lab.directory, key("shop"), "managed"); await rename(directory, directory + ".held"); await lab.reopen();
  await assert.rejects(lab.index().managedState("shop", lab.runtime), /missing/); await assert.rejects(lab.index().prepareApp("shop"), /missing/);
});

test("unregistered data identities and missing build receipts fail before managed admission", async (t) => {
  const lab = await managedIndexFixture(t); const missing = parseManagedLifecycleSource({ ...lab.source, candidate: { ...lab.plan, artifact: "f".repeat(64) } }); await assert.rejects(lab.index().requestManagedDeployment("shop", missing, lab.runtime), /preflight/);
  const database = lab.plan.services["db"]; assert.ok(database); const first = database.mounts[0]; assert.ok(first); const allocation = randomUUID();
  const foreign = parseManagedLifecycleSource({ ...lab.source, candidate: { ...lab.plan, services: { ...lab.plan.services, db: { ...database, mounts: [{ ...first, volume: { ...first.volume, allocation, name: "kayra-data-" + allocation } }] } } } });
  await assert.rejects(lab.index().requestManagedDeployment("shop", foreign, lab.runtime), /preflight/); assert.deepEqual(await lab.index().pendingManagedDeployments(), []); assert.equal(lab.hostCalls(), 0);
});

test("managed index records require both protocol and source bindings and never adopt a changed source at the same sequence", async (t) => {
  const lab = await managedIndexFixture(t); await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime); await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime);
  const state = await saved(lab.directory); const binding = state.managedBindings?.[0]; assert.ok(binding);
  assert.throws(() => parseLifecycleAppIndex({ ...state, managedBindings: [] }), /ownership/);
  assert.throws(() => parseLifecycleAppIndex({ ...state, apps: state.apps.map((item) => ({ app: item.app, incarnation: item.incarnation, dataOwner: item.dataOwner, volumes: item.volumes, phase: item.phase })) }), /ownership/);
  await lab.index().close(); const journal = await openJournal(lab.directory, "existing"); try { await journal.write({ ...state, managedBindings: [{ ...binding, source: "f".repeat(64) }] }); } finally { await journal.close(); } await lab.reopen();
  const blocked = await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); assert.equal(blocked?.operation.phase, "held"); assert.equal(blocked.operation.reason, "admission");
  await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); const unsettled = await lab.index().tickManagedDeployment("shop", lab.source.run, lab.runtime); assert.equal(unsettled?.operation.phase, "settling"); assert.equal((await lab.index().resourceSnapshot())?.charges[0]?.result, "pending");
});
