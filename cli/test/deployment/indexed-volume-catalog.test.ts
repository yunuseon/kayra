import { tmpdir } from "node:os";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types -- models native volume state and index restart */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { managedIndexRuntimeFixture } from "./managed-index-runtime-fixture.ts";
import { managedIndexFixture } from "./managed-index-fixture.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { parseLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index-state.ts";
import type { IndexedManagedRuntime } from "../../src/server/deployment/indexed-managed-lifecycle.ts";
import type { VolumeAction, VolumeObservation } from "../../src/contracts/owned-volume.ts";
import { typed } from "../../src/lib/typed.ts";

const appPath = (directory: string) => join(directory, createHash("sha256").update("shop").digest("hex"));

test("the index owns catalog storage and supplies receipts without recursive app locking across lost Create acknowledgement", async (t) => {
  const lab = await managedIndexRuntimeFixture(t); let observation: VolumeObservation = { status: "absent" }; const calls: VolumeAction[] = []; let receiptInputs = 0;
  const runtime = typed<IndexedManagedRuntime>({ ...lab.runtime, managedData: {
    native: { observe: () => Promise.resolve(observation), create: async (action) => { assert.equal((await lab.index().resourceSnapshot())?.charges[0]?.result, "pending"); calls.push(action); observation = { status: "owned", receipt: { volume: action.volume, createdAt: new Date(1000).toISOString() } }; throw new Error("lost native Create acknowledgement"); } },
    workloads: (receipts) => ({ ...lab.runtime.services, apply: async (action, expected, spec, application) => { const result = await receipts.read(spec.mounts.map((mount) => mount.volume)); assert.ok(result); if (spec.mounts.length > 0) receiptInputs++; return lab.runtime.services.apply(action, expected, spec, application); } }),
  } });
  await assert.rejects(lab.index().requestManagedDeployment("shop", lab.source, runtime), /version 2/); assert.deepEqual(await lab.index().pendingManagedDeployments(), []);
  const source = parseManagedLifecycleSource({ ...lab.source, version: 2 }); await lab.index().requestManagedDeployment("shop", source, runtime); assert.equal(calls.length, 0);
  await lab.index().tickManagedDeployment("shop", source.run, runtime); const intent = await lab.index().tickManagedDeployment("shop", source.run, runtime); assert.equal(intent?.operation.phase, "allocating");
  await lab.index().tickManagedDeployment("shop", source.run, runtime); assert.equal(calls.length, 1); await lab.reopen();
  for (let i = 0; i < 120; i++) { const state = await lab.index().tickManagedDeployment("shop", source.run, runtime); assert.notEqual(state?.operation.phase, "held"); if (state?.operation.phase === "complete") break; }
  const complete = await lab.index().managedState("shop", runtime); assert.equal(complete?.operation.phase, "complete"); assert.equal(complete.operation.allocation?.deadline, intent.operation.allocation?.deadline); assert.equal(calls.length, 1); assert.ok(receiptInputs > 0);
  assert.deepEqual(await lab.index().recordedManagedVolumes("shop", lab.volumes), lab.volumes.map((volume) => ({ volume, createdAt: new Date(1000).toISOString() })));
  await lab.reopen(); assert.equal((await lab.index().recordedManagedVolumes("shop", lab.volumes))?.length, 1); assert.equal(calls.length, 1);
});

test("missing known catalogs are refused while foreign receipt requests fail before opening storage", async (t) => {
  const lab = await managedIndexFixture(t); const directory = join(appPath(lab.directory), "managed", "volumes"); await rename(directory, directory + ".held"); const volume = lab.volumes[0]; assert.ok(volume);
  assert.equal(await lab.index().recordedManagedVolumes("shop", [{ ...volume, allocation: randomUUID() }]), undefined);
  await assert.rejects(lab.index().recordedManagedVolumes("shop", lab.volumes), /missing/); await assert.rejects(lab.index().prepareApp("shop"), /missing/);
  const state: unknown = JSON.parse(await readFile(join(lab.directory, "state.json"), "utf8")); assert.equal(parseLifecycleAppIndex(state).apps[0]?.managedVolumes, 1);
});

test("historical managed records without a catalog marker cannot silently opt into catalog storage", async (t) => {
  const lab = await managedIndexFixture(t); await lab.index().close(); const journal = await openJournal(lab.directory, "existing");
  try { const state = parseLifecycleAppIndex(await journal.read()); await journal.write({ ...state, apps: state.apps.map(({ managedVolumes, ...entry }) => { assert.equal(managedVolumes, 1); return entry; }) }); } finally { await journal.close(); }
  await lab.reopen(); assert.equal(await lab.index().recordedManagedVolumes("shop", lab.volumes), undefined);
  const runtime = typed<IndexedManagedRuntime>({ ...lab.runtime, managedData: { native: { observe: () => Promise.resolve({ status: "absent" }), create: () => Promise.resolve("refused") }, workloads: () => lab.runtime.services } });
  await assert.rejects(lab.index().requestManagedDeployment("shop", parseManagedLifecycleSource({ ...lab.source, version: 2 }), runtime), /capability/); assert.deepEqual(await lab.index().pendingManagedDeployments(), []);
});

for (const cut of ["before", "after"] as const) test(`catalog initialization ${cut}-replacement interruption retains one owned initialization`, async (t) => {
  const path = await mkdtemp(join(tmpdir(), "kayra-index-catalog-cut-")); const directory = join(path, "index"); let failed = false; let replacements = 0;
  const journals = async (...args: Parameters<typeof openJournal>) => { const journal = await openJournal(...args); return { ...journal, write: async (value: Parameters<typeof journal.write>[0]) => {
    if (args[0].endsWith(join("managed", "volumes"))) { if (!failed && cut === "before") { failed = true; throw new Error("lost initialization"); } await journal.write(value); replacements++; if (!failed) { failed = true; throw new Error("lost initialization"); } } else await journal.write(value);
  } }; };
  let index = await createLifecycleAppIndex(directory, undefined, journals); t.after(async () => { await index.close(); await rm(path, { recursive: true, force: true }); });
  await assert.rejects(index.prepareApp("shop", "managed-v3"), /lost initialization/); await index.close(); index = await openLifecycleAppIndex(directory, undefined, journals); await index.prepareApp("shop", "managed-v3");
  const state = parseLifecycleAppIndex(JSON.parse(await readFile(join(directory, "state.json"), "utf8"))); assert.equal(state.apps[0]?.phase, "ready"); assert.equal(state.apps[0].managedVolumes, 1); assert.equal(replacements, 1);
  assert.deepEqual(await index.recordedManagedVolumes("shop", []), []);
});
