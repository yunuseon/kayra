import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { registrationControl } from "../../src/server/deployment/registration-control.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { openLifecycleEnvelopeStore } from "../../src/server/deployment/lifecycle-envelope-store.ts";

const incarnation = "11111111-1111-4111-8111-111111111111";
const generation = "22222222-2222-4222-8222-222222222222";
const key = (app: string) => createHash("sha256").update(app).digest("hex");
// eslint-disable-next-line functional/prefer-immutable-types -- node:test owns the mutable cleanup context
const fixture = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "kayra-app-index-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "index");
};

test("indexed registration keeps its identity, intent and receipt across reopen", async (t) => {
  const root = await fixture(t);
  const app = "a".repeat(300) + "-";
  await assert.rejects(openLifecycleAppIndex(root), /missing/);
  const first = await createLifecycleAppIndex(root);
  try {
    await assert.rejects(openLifecycleAppIndex(root), /locked/);
    await assert.rejects(createLifecycleAppIndex(root), { code: "EEXIST" });
    await assert.rejects(first.reserveRegistration(app), /not ready/);
    await assert.rejects(first.prepareApp("../shop"), /invalid lifecycle app name/);
    const [id, retry] = await Promise.all([first.prepareApp(app), first.prepareApp(app)]);
    assert.equal(id, retry);
    assert.notEqual(await first.prepareApp("other"), id);
    assert.ok((await lstat(join(root, key(app)))).isDirectory());
    const ticket = await first.reserveRegistration(app);
    assert.equal(ticket, `${id}:1`);
    const intent = await first.submitRegistration(app, ticket, generation);
    assert.deepEqual(intent, { status: "new", actionId: ticket });
    await first.close();

    const recovered = await openLifecycleAppIndex(root, (expected) => {
      assert.deepEqual(expected, { app, incarnation: id, actionId: ticket, registrationGeneration: generation });
      return Promise.resolve({ ...expected, status: "applied" });
    });
    try {
      assert.equal(await recovered.prepareApp(app), id);
      assert.deepEqual(await recovered.submitRegistration(app, ticket, generation), { status: "reconcile", actionId: ticket });
      assert.deepEqual(await recovered.reconcileRegistration(app, ticket, generation), { status: "verified" });
    } finally {
      await recovered.close();
    }

    const final = await openLifecycleAppIndex(root);
    try {
      assert.deepEqual(await final.submitRegistration(app, ticket, generation), { status: "terminal", outcome: "success" });
      await assert.rejects(final.reserveRegistration(app), /already in progress or complete/);
      await assert.rejects(final.submitRegistration("other", ticket, generation), /invalid or unissued ticket/);
    } finally {
      await final.close();
    }
  } finally {
    await first.close();
  }
});

test("indexed ownership is held when a ready journal disappears or belongs to another app", async (t) => {
  const root = await fixture(t);
  const first = await createLifecycleAppIndex(root);
  await first.prepareApp("shop");
  await first.prepareApp("other");
  await first.close();

  const path = join(root, key("shop"));
  const saved = join(root, "saved");
  await rename(path, saved);
  const index = await openLifecycleAppIndex(root);
  try {
    await assert.rejects(index.prepareApp("shop"), /missing or invalid/);
    await assert.rejects(lstat(path), { code: "ENOENT" });
    const other = join(root, key("other"));
    await symlink(other, path);
    await assert.rejects(index.reserveRegistration("shop"), /missing or invalid/);
    await rm(path);
    await rename(other, path);
    await assert.rejects(index.reserveRegistration("shop"), /disagrees with app index/);
    await rename(path, other);
    await rename(saved, path);
    const lock = join(path, "writer-lock.sqlite");
    await rm(lock);
    await assert.rejects(index.prepareApp("shop"), /journal files are missing or invalid/);
    await assert.rejects(lstat(lock), { code: "ENOENT" });
    await mkdir(join(root, key("orphan")));
    await assert.rejects(index.prepareApp("orphan"), /unindexed lifecycle directory/);
  } finally {
    await index.close();
  }
  await rm(join(root, "state.json"));
  await assert.rejects(openLifecycleAppIndex(root), /journal files are missing or invalid/);
  await assert.rejects(createLifecycleAppIndex(root), { code: "EEXIST" });
});

test("observation fences one app and close drains its accepted calls", { timeout: 5000 }, async (t) => {
  const root = await fixture(t);
  const started = Promise.withResolvers<undefined>();
  const observed = Promise.withResolvers<undefined>();
  t.after(() => { observed.resolve(undefined); });
  const index = await createLifecycleAppIndex(root, async (expected) => {
    started.resolve(undefined);
    await observed.promise;
    return { ...expected, status: "applied" };
  });
  try {
    await index.prepareApp("shop");
    const ticket = await index.reserveRegistration("shop");
    await index.submitRegistration("shop", ticket, generation);
    const reconcile = index.reconcileRegistration("shop", ticket, generation);
    await started.promise;

    const retry = index.submitRegistration("shop", ticket, generation);
    const other = await index.prepareApp("other");
    assert.equal(await index.reserveRegistration("other"), `${other}:1`);
    const closing = index.close();
    await assert.rejects(index.prepareApp("third"), /closed/);
    await assert.rejects(openLifecycleAppIndex(root), /locked/);

    observed.resolve(undefined);
    assert.deepEqual(await reconcile, { status: "verified" });
    assert.deepEqual(await retry, { status: "terminal", outcome: "success" });
    await closing;
    await (await openLifecycleAppIndex(root)).close();
  } finally {
    observed.resolve(undefined);
    await index.close();
  }
});

// Materialize each durable prefix under real locks so the kill point is deterministic.
const journalUrl = new URL("../../src/server/deployment/journal.ts", import.meta.url).href;
const storeUrl = new URL("../../src/server/deployment/lifecycle-envelope-store.ts", import.meta.url).href;
const childSource = `
import { mkdir, open } from "node:fs/promises";
import { openJournal } from ${JSON.stringify(journalUrl)};
import { openLifecycleEnvelopeStore } from ${JSON.stringify(storeUrl)};
const [root, appPath, phase] = process.argv.slice(1);
const index = await openJournal(root, "existing");
await index.write({version: 1, apps: [{app: "shop", incarnation: ${JSON.stringify(incarnation)}, phase: "initializing"}]});
if (phase !== "intent") {
  await mkdir(appPath);
  const parent = await open(root, "r");
  await parent.sync();
  await parent.close();
  const app = await openJournal(appPath);
  if (phase === "envelope") await openLifecycleEnvelopeStore(app).initialize("shop", ${JSON.stringify(incarnation)});
}
console.log("ready");
setInterval(() => {}, 1000);
`;

test("restart finishes journal creation at the same incarnation after a writer is killed", async (t) => {
  for (const phase of ["intent", "directory", "envelope"]) {
    await t.test(phase, async (sub) => {
      const root = await fixture(sub);
      await (await createLifecycleAppIndex(root)).close();
      const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "--eval", childSource, root, join(root, key("shop")), phase],
        { stdio: ["ignore", "pipe", "inherit"] });
      const lines = createInterface({ input: child.stdout });
      const exited = once(child, "exit");
      try {
        const result = await Promise.race([
          once(lines, "line").then((args: readonly unknown[]) => args[0]),
          exited.then(() => { throw new Error("writer exited before the test kill point"); }),
        ]);
        assert.equal(result, "ready");
        await assert.rejects(openLifecycleAppIndex(root), /locked/);
        child.kill("SIGKILL");
        await exited;
      } finally {
        lines.close();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      }
      const index = await openLifecycleAppIndex(root);
      try {
        await assert.rejects(index.reserveRegistration("shop"), /not ready/);
        assert.equal(await index.prepareApp("shop"), incarnation);
        assert.equal(await index.reserveRegistration("shop"), `${incarnation}:1`);
      } finally {
        await index.close();
      }
    });
  }
});

test("initializing ownership refuses an envelope that already issued tickets", async (t) => {
  const root = await fixture(t);
  await (await createLifecycleAppIndex(root)).close();
  const indexJournal = await openJournal(root, "existing");
  await indexJournal.write({ version: 1, apps: [{ app: "shop", incarnation, phase: "initializing" }] });
  await indexJournal.close();
  const path = join(root, key("shop"));
  await mkdir(path);
  const journal = await openJournal(path);
  const store = openLifecycleEnvelopeStore(journal);
  await store.initialize("shop", incarnation);
  await store.reserveRegistration();
  await journal.close();

  const index = await openLifecycleAppIndex(root);
  try {
    await assert.rejects(index.prepareApp("shop"), /disagrees with app index/);
    await assert.rejects(index.reserveRegistration("shop"), /not ready/);
  } finally {
    await index.close();
  }
});

test("initial registration allocation is bound to one generation across concurrent retries", async (t) => {
  const root = await fixture(t);
  const index = await createLifecycleAppIndex(root);
  try {
    const id = await index.prepareApp("shop");
    await assert.rejects(index.reserveRegistration("shop", "bad"), /invalid registration generation/);
    const tickets = await Promise.all(Array.from({ length: 70 }, () => index.reserveRegistration("shop", generation)));
    assert.deepEqual(new Set(tickets), new Set([`${id}:1`]));
    await assert.rejects(index.submitRegistration("shop", `${id}:1`, incarnation), /allocation conflict/);
    await assert.rejects(index.reserveRegistration("shop"), /allocation conflict/);
  } finally {
    await index.close();
  }
});

test("the registration projection requires a verified durable receipt", async (t) => {
  const root = await fixture(t);
  const observer = (expected: { readonly app: string; readonly incarnation: string; readonly actionId: string; readonly registrationGeneration: string }) =>
    Promise.resolve({ ...expected, status: "applied" });
  const index = await createLifecycleAppIndex(root, observer);
  const id = await index.prepareApp("shop");
  const ticket = await index.reserveRegistration("shop", generation);
  try {
    await assert.rejects(index.verifiedRegistration("shop"), /not been verified/);
    await index.submitRegistration("shop", ticket, generation);
    await assert.rejects(index.verifiedRegistration("shop"), /not been verified/);
    await index.reconcileRegistration("shop", ticket, generation);
    assert.deepEqual(await index.verifiedRegistration("shop"), {
      version: 1, app: "shop", incarnation: id, actionId: id + ":1", registrationGeneration: generation,
    });
  } finally {
    await index.close();
  }
  const reopened = await openLifecycleAppIndex(root);
  try {
    assert.equal((await reopened.verifiedRegistration("shop")).registrationGeneration, generation);
  } finally {
    await reopened.close();
  }
});

test("a selected runtime is persisted before publication and refuses conversion across restart", async (t) => {
  const root = await fixture(t);
  const index = await createLifecycleAppIndex(root, (identity) => Promise.resolve({ ...identity, status: "applied" }));
  await index.prepareApp("shop");
  const ticket = await index.reserveRegistration("shop", generation, "swarm");
  await assert.rejects(index.reserveRegistration("shop", generation, "compose"), /allocation conflict/);
  await assert.rejects(index.registrationPolicy("shop"), /not been verified/);
  await index.submitRegistration("shop", ticket, generation);
  await index.reconcileRegistration("shop", ticket, generation);
  const policy = await index.registrationPolicy("shop");
  assert.equal(policy.runtime, "swarm");
  assert.equal(policy.metadata.registrationGeneration, generation);
  await index.close();
  const reopened = await openLifecycleAppIndex(root);
  try {
    assert.deepEqual(await reopened.registrationPolicy("shop"), policy);
    assert.equal(await reopened.reserveRegistration("shop", generation, "swarm"), ticket);
    await assert.rejects(reopened.reserveRegistration("shop", generation), /allocation conflict/);
  } finally { await reopened.close(); }
});

test("control refuses Swarm reservation without a platform capability and publishes only verified policy", async (t) => {
  const root = await fixture(t);
  const index = await createLifecycleAppIndex(root, (identity) => Promise.resolve({ ...identity, status: "applied" }));
  try {
    const disabled = registrationControl({ index, canRegister: () => Promise.resolve(true) });
    await assert.rejects(disabled("/registration/reserve", { app: "shop", generation, runtime: "swarm" }), /not enabled/);
    await assert.rejects(index.registrationPolicy("shop"), /not ready/);
    const enabled = registrationControl({ index, canRegister: () => Promise.resolve(true), runtimeEnabled: () => Promise.resolve(true) });
    const reserved = await enabled("/registration/reserve", { app: "shop", generation, runtime: "swarm" });
    assert.ok(reserved !== undefined && "ticket" in reserved);
    await assert.rejects(enabled("/registration/policy", { app: "shop" }), /not been verified/);
    await assert.rejects(enabled("/registration/reserve", { app: "shop", generation, runtime: "compose" }), /allocation conflict/);
    await enabled("/registration/submit", { app: "shop", generation, ticket: reserved.ticket });
    await enabled("/registration/reconcile", { app: "shop", generation, ticket: reserved.ticket });
    assert.deepEqual(await disabled("/registration/policy", { app: "shop" }), await index.registrationPolicy("shop"));
  } finally { await index.close(); }
});
