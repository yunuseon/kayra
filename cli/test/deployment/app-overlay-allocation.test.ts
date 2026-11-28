/* eslint-disable functional/no-let -- fixture owns a simulated daemon and clock */
/* eslint-disable functional/prefer-immutable-types -- TestContext and journal are externally owned handles */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AppOverlayGrant, AppOverlayPort } from "../../src/contracts/app-overlay.ts";
import { appOverlayAllocation } from "../../src/server/platform/app-overlay-allocation.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";

const incarnation = "11111111-1111-4111-8111-111111111111";
const reference = { version: 1, runtime: "swarm", registration: { version: 1, app: "shop", incarnation, actionId: incarnation + ":1", registrationGeneration: "22222222-2222-4222-8222-222222222222" }, ownership: { version: 1, app: "shop", incarnation, dataOwner: "33333333-3333-4333-8333-333333333333" } } as const;
const scope = { version: 1, app: "shop", incarnation, node: "a".repeat(25), cluster: "b".repeat(25), name: `kayra-app-${incarnation}` } as const;
const grant = { scope, id: "c".repeat(25) };
const fixture = async (t: TestContext) => {
  const path = await mkdtemp(join(tmpdir(), "kayra-overlay-allocation-"));
  let journal = await openJournal(path); let time = 100; let actual: AppOverlayGrant | null = null; let creates = 0; let authorized = true;
  const native: AppOverlayPort = {
    observe: () => Promise.resolve(actual === null ? { status: "absent" } : { status: "owned", grant: actual }),
    create: async () => { assert.notEqual(await journal.read(), undefined, "intent must be synchronized first"); creates += 1; actual = grant; return "acknowledged"; },
  };
  const ports = () => ({ storage: journal, native, now: () => time, newId: randomUUID, authorize: () => Promise.resolve(authorized) });
  const controller = () => appOverlayAllocation(ports());
  const reopen = async () => { await journal.close(); journal = await openJournal(path, "existing"); return controller(); };
  t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  return { controller, ports, reopen, native, path, read: () => journal.read(), creates: () => creates, time: (value: number) => { time = value; }, missing: () => { actual = null; }, setGrant: (value: AppOverlayGrant) => { actual = value; }, deny: () => { authorized = false; } };
};

test("overlay allocation persists intent and physical grant, serializes retries and survives reopen", async (t) => {
  const f = await fixture(t); const controller = f.controller();
  const results = await Promise.all([controller.provision(reference, scope), controller.provision(reference, scope)]);
  assert.deepEqual(results, [{ ok: true, value: grant }, { ok: true, value: grant }]); assert.equal(f.creates(), 1);
  await assert.rejects(openJournal(f.path), /locked|busy/i);
  f.time(100000); const reopened = await f.reopen(); assert.deepEqual(await reopened.provision(reference, scope), results[0]); assert.equal(f.creates(), 1);
});

test("lost grant-write acknowledgement poisons the caller, then reopen observes the original identity", async (t) => {
  const f = await fixture(t); const ports = f.ports(); let writes = 0;
  const controller = appOverlayAllocation({ ...ports, storage: { read: ports.storage.read, write: async (state) => { await ports.storage.write(state); writes += 1; if (writes === 2) throw new Error("private fixture failure"); } } });
  await assert.rejects(controller.provision(reference, scope), /write is uncertain/);
  await assert.rejects(controller.provision(reference, scope), /requires reopen/);
  const reopened = await f.reopen(); assert.deepEqual(await reopened.provision(reference, scope), { ok: true, value: grant }); assert.equal(f.creates(), 1);
});

test("an acknowledged native create with an unrecorded receipt is observed on reopen without another create", async (t) => {
  const f = await fixture(t); const ports = f.ports(); let writes = 0;
  const controller = appOverlayAllocation({ ...ports, storage: { read: ports.storage.read, write: async (state) => { writes += 1; if (writes === 2) throw new Error("killed before receipt"); await ports.storage.write(state); } } });
  await assert.rejects(controller.provision(reference, scope), /uncertain/);
  const before = await f.read(); f.time(91000); const reopened = await f.reopen(); assert.deepEqual(await reopened.provision(reference, scope), { ok: true, value: grant });
  assert.equal(f.creates(), 1); const after = await f.read();
  assert.equal(Reflect.get(Reflect.get(before ?? {}, "action"), "deadline"), Reflect.get(Reflect.get(after ?? {}, "action"), "deadline"));
});

test("an expired uncreated allocation cannot get another effect deadline", async (t) => {
  const f = await fixture(t); f.deny(); const controller = f.controller(); assert.equal((await controller.provision(reference, scope)).ok, false);
  f.time(91000); const reopened = await f.reopen(); assert.equal((await reopened.provision(reference, scope)).ok, false); assert.equal(f.creates(), 0);
});

test("a missing or replaced recorded network is refused without recreation", async (t) => {
  const f = await fixture(t); const controller = f.controller(); assert.equal((await controller.provision(reference, scope)).ok, true);
  f.missing(); assert.equal((await controller.provision(reference, scope)).ok, false);
  f.setGrant({ scope, id: "d".repeat(25) }); assert.equal((await controller.provision(reference, scope)).ok, false); assert.equal(f.creates(), 1);
});

test("ownership, generation or host changes cannot reuse the platform allocation", async (t) => {
  const f = await fixture(t); const controller = f.controller(); await controller.provision(reference, scope);
  for (const changed of [
    { ...reference, ownership: { ...reference.ownership, dataOwner: randomUUID() } },
    { ...reference, registration: { ...reference.registration, registrationGeneration: randomUUID() } },
  ]) assert.equal((await controller.provision(changed, scope)).ok, false);
  assert.equal((await controller.provision(reference, { ...scope, node: "d".repeat(25) })).ok, false); assert.equal(f.creates(), 1);
});

test("an uncertain intent write prevents native effects until reopened", async (t) => {
  const f = await fixture(t); const ports = f.ports();
  const controller = appOverlayAllocation({ ...ports, storage: { read: ports.storage.read, write: async (state) => { await ports.storage.write(state); throw new Error("private path"); } } });
  await assert.rejects(controller.provision(reference, scope), /write is uncertain/); assert.equal(f.creates(), 0);
  const reopened = await f.reopen(); assert.equal((await reopened.provision(reference, scope)).ok, true); assert.equal(f.creates(), 1);
});
