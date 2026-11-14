/* eslint-disable functional/no-let, functional/prefer-immutable-types -- owns isolated journal fault fixtures */
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { parseDataOwnership } from "../../src/contracts/owned-volume.ts";

const fixture = async (t: TestContext) => { const directory = await mkdtemp(join(tmpdir(), "kayra-data-owner-")); t.after(() => rm(directory, { recursive: true, force: true })); return join(directory, "index"); };
const observer = (identity: Readonly<Record<string, string | number>>) => Promise.resolve({ ...identity, status: "applied" });
const register = async (index: Awaited<ReturnType<typeof openLifecycleAppIndex>>, app: string, runtime: "swarm" | "compose") => {
  const incarnation = await index.prepareApp(app); const generation = randomUUID(); const ticket = await index.reserveRegistration(app, generation, runtime);
  await index.submitRegistration(app, ticket, generation); await index.reconcileRegistration(app, ticket, generation); return incarnation;
};

test("new Swarm app data ownership is independent, unique and unchanged by registration retry or reopen", async (t) => {
  const root = await fixture(t); const index = await createLifecycleAppIndex(root, observer);
  const incarnation = await register(index, "shop", "swarm"); const owner = await index.dataOwnership("shop"); assert.notEqual(owner.dataOwner, incarnation); assert.equal(owner.incarnation, incarnation); assert.ok(Object.isFrozen(owner));
  await register(index, "other", "swarm"); assert.notEqual((await index.dataOwnership("other")).dataOwner, owner.dataOwner);
  assert.equal(await index.prepareApp("shop"), incarnation); assert.deepEqual(await index.dataOwnership("shop"), owner); await index.close();
  const reopened = await openLifecycleAppIndex(root, observer); try { assert.deepEqual(await reopened.dataOwnership("shop"), owner); } finally { await reopened.close(); }
});

test("data references require verified registration and do not change a Compose app backend", async (t) => {
  const index = await createLifecycleAppIndex(await fixture(t), observer);
  try {
    await index.prepareApp("pending"); await assert.rejects(index.dataOwnership("pending"), /not been verified/);
    const incarnation = await register(index, "legacy", "compose"); assert.notEqual((await index.dataOwnership("legacy")).dataOwner, incarnation);
    assert.equal((await index.registrationPolicy("legacy")).runtime, "compose"); assert.equal((await index.deploymentStatus("legacy")).verification, "legacy-unverified");
  } finally { await index.close(); }
});

test("interruption after the ownership write preserves the original data UUID before envelope creation", async (t) => {
  const root = await fixture(t); let checkpoint: string | undefined;
  const journals: typeof openJournal = async (path, mode) => {
    const actual = await openJournal(path, mode);
    return { ...actual, write: async (value) => {
      await actual.write(value);
      const checked = z.object({ apps: z.array(z.object({ phase: z.string(), dataOwner: z.uuid() })) }).safeParse(value);
      if (path === root && checkpoint === undefined && checked.success && checked.data.apps[0]?.phase === "initializing") { checkpoint = checked.data.apps[0].dataOwner; throw new Error("injected lost write acknowledgement"); }
    } };
  };
  const index = await createLifecycleAppIndex(root, observer, journals); await assert.rejects(index.prepareApp("shop"), /lost write acknowledgement/); assert.ok(checkpoint); await index.close();
  const recovered = await openLifecycleAppIndex(root, observer); try { await register(recovered, "shop", "swarm"); assert.equal((await recovered.dataOwnership("shop")).dataOwner, checkpoint); } finally { await recovered.close(); }
});

test("older rows stay readable without inventing ownership from their app incarnation", async (t) => {
  const root = await fixture(t); const initial = await createLifecycleAppIndex(root, observer); const incarnation = await register(initial, "shop", "swarm"); await initial.close();
  const journal = await openJournal(root, "existing"); await journal.write({ version: 1, apps: [{ app: "shop", incarnation, phase: "ready" }] }); await journal.close(); const before = await readFile(join(root, "state.json"), "utf8");
  const reopened = await openLifecycleAppIndex(root, observer); try { assert.equal(await reopened.prepareApp("shop"), incarnation); await assert.rejects(reopened.dataOwnership("shop"), /older application/); } finally { await reopened.close(); }
  assert.equal(await readFile(join(root, "state.json"), "utf8"), before);
});

test("duplicate or incarnation-derived data ownership is rejected on reopening the index", async (t) => {
  for (const duplicate of [true, false]) {
    const root = await fixture(t); const index = await createLifecycleAppIndex(root, observer); const first = await register(index, "shop", "swarm"); const second = await register(index, "other", "swarm"); const owner = await index.dataOwnership("shop"); await index.close();
    const journal = await openJournal(root, "existing"); await journal.write({ version: 1, apps: [{ app: "shop", incarnation: first, phase: "ready", dataOwner: duplicate ? owner.dataOwner : first }, { app: "other", incarnation: second, phase: "ready", dataOwner: owner.dataOwner }] }); await journal.close();
    await assert.rejects(openLifecycleAppIndex(root), /index is invalid/);
  }
  assert.equal(parseDataOwnership({ version: 1, app: "shop", incarnation: randomUUID(), dataOwner: "bad" }).ok, false);
});
