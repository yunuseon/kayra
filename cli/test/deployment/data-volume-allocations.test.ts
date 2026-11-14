/* eslint-disable functional/no-let, functional/prefer-immutable-types -- isolated durable-write fault fixtures */
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { ownedVolume } from "../../src/contracts/owned-volume.ts";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";

const fixture = async (t: TestContext) => { const path = await mkdtemp(join(tmpdir(), "kayra-volume-allocation-")); t.after(() => rm(path, { recursive: true, force: true })); return join(path, "index"); };
const observer = (identity: Readonly<Record<string, string | number>>) => Promise.resolve({ ...identity, status: "applied" });
const register = async (index: Awaited<ReturnType<typeof openLifecycleAppIndex>>, app = "shop", runtime: "swarm" | "compose" = "swarm") => {
  await index.prepareApp(app); const generation = randomUUID(); const ticket = await index.reserveRegistration(app, generation, runtime);
  await index.submitRegistration(app, ticket, generation); await index.reconcileRegistration(app, ticket, generation);
};

test("volume identities are durable before effects and survive reopen, reorder and omission from another release", async (t) => {
  const root = await fixture(t); const index = await createLifecycleAppIndex(root, observer); await register(index);
  const initial = await index.reserveDataVolumeIdentities("shop", ["uploads", "database"]); assert.equal(initial.length, 2);
  assert.equal(new Set(initial.map((volume) => volume.allocation)).size, 2); assert.ok(Object.isFrozen(initial)); assert.ok(Object.isFrozen(initial[0]));
  const owner = await index.dataOwnership("shop"); assert.ok(initial.every((volume) => volume.dataOwner === owner.dataOwner && volume.name === `kayra-data-${volume.allocation}`));
  assert.deepEqual(await index.reserveDataVolumeIdentities("shop", ["database", "uploads"]), initial);
  assert.deepEqual(await index.reserveDataVolumeIdentities("shop", ["uploads"]), initial.filter((volume) => volume.key === "uploads")); await index.close();
  const reopened = await openLifecycleAppIndex(root, observer); try { assert.deepEqual(await reopened.reserveDataVolumeIdentities("shop", ["database", "uploads"]), initial); } finally { await reopened.close(); }
});

test("concurrent allocations of the same key share one persisted identity without losing unrelated keys", async (t) => {
  const index = await createLifecycleAppIndex(await fixture(t), observer);
  try {
    await register(index); const [first, second] = await Promise.all([index.reserveDataVolumeIdentities("shop", ["data", "files"]), index.reserveDataVolumeIdentities("shop", ["data", "cache"])]);
    assert.deepEqual(first.find((volume) => volume.key === "data"), second.find((volume) => volume.key === "data"));
    assert.equal((await index.reserveDataVolumeIdentities("shop", ["cache", "data", "files"])).length, 3);
    await register(index, "other"); assert.notEqual((await index.reserveDataVolumeIdentities("other", ["data"]))[0]?.allocation, first[0]?.allocation);
  } finally { await index.close(); }
});

test("lost allocation acknowledgement reopens the same names instead of allocating empty replacement data", async (t) => {
  const root = await fixture(t); let identities: unknown;
  const journals: typeof openJournal = async (path, mode) => {
    const actual = await openJournal(path, mode);
    return { ...actual, write: async (value) => {
      await actual.write(value); const checked = z.object({ apps: z.array(z.object({ volumes: z.array(z.unknown()) })) }).safeParse(value);
      if (path === root && identities === undefined && checked.success && (checked.data.apps[0]?.volumes.length ?? 0) > 0) {
        identities = checked.data.apps[0]?.volumes; throw new Error("injected lost allocation acknowledgement");
      }
    } };
  };
  const index = await createLifecycleAppIndex(root, observer, journals); await register(index); await assert.rejects(index.reserveDataVolumeIdentities("shop", ["data"]), /lost allocation/); await index.close();
  const recovered = await openLifecycleAppIndex(root, observer); try { assert.deepEqual(await recovered.reserveDataVolumeIdentities("shop", ["data"]), identities); } finally { await recovered.close(); }
});

test("unverified and Compose apps cannot allocate managed Swarm volume identities", async (t) => {
  const root = await fixture(t); const index = await createLifecycleAppIndex(root, observer);
  try {
    await index.prepareApp("pending"); await assert.rejects(index.reserveDataVolumeIdentities("pending", ["data"]), /not been verified/);
    await register(index, "legacy", "compose"); const before = await readFile(join(root, "state.json"), "utf8");
    await assert.rejects(index.reserveDataVolumeIdentities("legacy", ["data"]), /explicitly registered Swarm/); assert.equal(await readFile(join(root, "state.json"), "utf8"), before);
  } finally { await index.close(); }
});

test("invalid logical keys fail without changing durable allocations", async (t) => {
  const root = await fixture(t); const index = await createLifecycleAppIndex(root, observer); await register(index);
  try {
    const before = await readFile(join(root, "state.json"), "utf8");
    for (const keys of [["data", "data"], ["/host"], ["../data"], [""], ["${DATA}"], Array.from({ length: 33 }, (_, i) => `data${String(i)}`)]) await assert.rejects(index.reserveDataVolumeIdentities("shop", keys), /logical volume keys/);
    assert.equal(await readFile(join(root, "state.json"), "utf8"), before);
  } finally { await index.close(); }
});

test("foreign owner or duplicate logical-key allocation records are rejected on reopen", async (t) => {
  for (const wrongOwner of [true, false]) {
    const root = await fixture(t); const index = await createLifecycleAppIndex(root, observer); await register(index); const volumes = await index.reserveDataVolumeIdentities("shop", ["data"]); const owner = await index.dataOwnership("shop"); await index.close();
    const other = ownedVolume("shop", wrongOwner ? randomUUID() : owner.dataOwner, randomUUID(), "data"); assert.ok(other.ok);
    const journal = await openJournal(root, "existing"); await journal.write({ version: 1, apps: [{ app: "shop", incarnation: owner.incarnation, dataOwner: owner.dataOwner, phase: "ready", volumes: wrongOwner ? [other.value] : [...volumes, other.value] }] }); await journal.close();
    await assert.rejects(openLifecycleAppIndex(root), /index is invalid/);
  }
});
