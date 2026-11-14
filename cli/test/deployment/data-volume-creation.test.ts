/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- owns isolated journal faults, runtime evidence and clock */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { ownedVolume } from "../../src/contracts/owned-volume.ts";
import type { VolumeAction, VolumeObservation } from "../../src/contracts/owned-volume.ts";
import { dataVolumeCreation, parseDataVolumeCreation } from "../../src/server/deployment/data-volume-creation.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import type { OperationJournal } from "../../src/server/deployment/operation.ts";

const fixture = async (t: TestContext) => {
  const path = await mkdtemp(join(tmpdir(), "kayra-volume-creation-")); t.after(() => rm(path, { recursive: true, force: true }));
  const owner = { version: 1, app: "shop", incarnation: randomUUID(), dataOwner: randomUUID() } as const;
  const volume = ownedVolume(owner.app, owner.dataOwner, randomUUID(), "data"); assert.ok(volume.ok);
  const action: VolumeAction = { volume: volume.value, operation: randomUUID(), deadline: 91000 };
  const request = { owner, deployment: "a".repeat(64), action, createdAt: 1000 };
  let clock = 1000; let observation: VolumeObservation = { status: "absent" }; let allow = true; let lostCreateAck = false;
  const creates: VolumeAction[] = []; let activeJournal: OperationJournal | undefined; let opened = false;
  const ports = { now: () => clock, authorize: () => Promise.resolve(allow), native: {
    observe: () => Promise.resolve(observation),
    create: async (input: VolumeAction) => { assert.ok(activeJournal); const intent = parseDataVolumeCreation(await activeJournal.read()); assert.equal(intent.phase, "creating"); assert.deepEqual(intent.action, input); creates.push(input); observation = { status: "owned", receipt: { volume: input.volume, createdAt: "2026-11-14T20:00:00Z" } }; if (lostCreateAck) throw new Error("lost native acknowledgement"); return "acknowledged" as const; },
  } };
  const open = async (wrap: (journal: OperationJournal) => OperationJournal = (journal) => journal, overrides: Partial<Parameters<typeof dataVolumeCreation>[1]> = {}) => {
    const journal = await openJournal(path, opened ? "existing" : "initialize"); opened = true; activeJournal = journal; t.after(() => journal.close()); return { journal, engine: dataVolumeCreation(wrap(journal), { ...ports, ...overrides }) };
  };
  return { request, ports, creates, open, time: (now: number) => { clock = now; }, observed: (value: VolumeObservation) => { observation = value; }, allowed: (value: boolean) => { allow = value; }, loseAck: () => { lostCreateAck = true; } };
};

test("creation persists intent before effects, then observes and synchronizes its receipt before reporting ready", async (t) => {
  const lab = await fixture(t); const opened = await lab.open(); await opened.engine.prepare(lab.request); assert.equal(lab.creates.length, 0);
  const creating = await opened.engine.tick(); assert.equal(creating.state.phase, "creating"); assert.equal(creating.state.receipt, null); assert.equal(lab.creates.length, 1);
  const ready = await opened.engine.tick(); assert.equal(ready.state.phase, "ready"); assert.equal(ready.observation, "owned"); assert.equal(ready.state.receipt, "2026-11-14T20:00:00Z");
  assert.equal(parseDataVolumeCreation(await opened.journal.read()).receipt, ready.state.receipt); assert.ok(Object.isFrozen(ready.state.action.volume));
});

test("restart after native creation loses no identity or deadline and issues no second Create", async (t) => {
  const lab = await fixture(t); lab.loseAck(); const first = await lab.open(); await first.engine.prepare(lab.request); await first.engine.tick(); await first.journal.close();
  const reopened = await lab.open(); const ready = await reopened.engine.tick(); assert.equal(ready.state.phase, "ready"); assert.equal(lab.creates.length, 1);
  assert.equal(ready.state.action.deadline, lab.request.action.deadline); assert.deepEqual(ready.state.action.volume, lab.request.action.volume);
});

test("a lost creating-intent acknowledgement poisons the writer before any native effect and reopens the same allocation", async (t) => {
  const lab = await fixture(t); let failed = false;
  const first = await lab.open((journal) => ({ read: journal.read, write: async (value) => { await journal.write(value); const state = parseDataVolumeCreation(value); if (!failed && state.phase === "creating") { failed = true; throw new Error("lost journal acknowledgement"); } } }));
  await first.engine.prepare(lab.request); await assert.rejects(first.engine.tick(), /uncertain/); await assert.rejects(first.engine.tick(), /uncertain/); assert.equal(lab.creates.length, 0); await first.journal.close();
  const reopened = await lab.open(); await reopened.engine.tick(); const ready = await reopened.engine.tick(); assert.equal(ready.state.phase, "ready"); assert.equal(lab.creates.length, 1); assert.equal(ready.state.attempts, 2);
});

test("a lost receipt acknowledgement cannot create another volume or replace the recorded creation time", async (t) => {
  const lab = await fixture(t); let failed = false;
  const first = await lab.open((journal) => ({ read: journal.read, write: async (value) => { await journal.write(value); if (!failed && parseDataVolumeCreation(value).phase === "ready") { failed = true; throw new Error("lost receipt acknowledgement"); } } }));
  await first.engine.prepare(lab.request); await first.engine.tick(); await assert.rejects(first.engine.tick(), /uncertain/); await first.journal.close();
  const reopened = await lab.open(); const ready = await reopened.engine.tick(); assert.equal(ready.state.phase, "ready"); assert.equal(ready.state.receipt, "2026-11-14T20:00:00Z"); assert.equal(lab.creates.length, 1);
});

test("a previously recorded volume that disappears is held and never silently recreated as empty storage", async (t) => {
  const lab = await fixture(t); const { engine } = await lab.open(); await engine.prepare(lab.request); await engine.tick(); await engine.tick(); lab.observed({ status: "absent" });
  const missing = await engine.tick(); assert.equal(missing.state.phase, "held"); assert.equal(missing.state.reason, "missing"); assert.equal(lab.creates.length, 1);
  await engine.tick(); assert.equal(lab.creates.length, 1);
});

test("preexisting unbacked ownership and changed creation evidence cannot be adopted", async (t) => {
  for (const created of [false, true]) {
    const lab = await fixture(t); const { engine } = await lab.open(); await engine.prepare(lab.request);
    if (created) { await engine.tick(); await engine.tick(); }
    lab.observed({ status: "owned", receipt: { volume: lab.request.action.volume, createdAt: "2026-11-14T21:00:00Z" } });
    const conflict = await engine.tick(); assert.equal(conflict.state.phase, "held"); assert.equal(conflict.state.reason, "conflict"); assert.equal(lab.creates.length, created ? 1 : 0);
  }
});

test("expired intent survives restart without fresh deadlines or effects", async (t) => {
  const lab = await fixture(t); const first = await lab.open(); await first.engine.prepare(lab.request); await first.journal.close(); lab.time(lab.request.action.deadline);
  const reopened = await lab.open(); const held = await reopened.engine.tick(); assert.equal(held.state.reason, "deadline"); assert.equal(lab.creates.length, 0);
  assert.equal((await reopened.engine.prepare(lab.request)).action.deadline, lab.request.action.deadline);
  await assert.rejects(reopened.engine.prepare({ ...lab.request, action: { ...lab.request.action, deadline: 90000 } }), /conflicts/);
});

test("post-deadline inspection is read-only evidence and cannot renew creation authority", async (t) => {
  const lab = await fixture(t); const { engine, journal } = await lab.open(); await engine.prepare(lab.request); await engine.tick(); await engine.tick(); lab.time(100000);
  const before = await journal.read(); assert.equal((await engine.inspect(101000)).status, "owned"); assert.deepEqual(await journal.read(), before);
  assert.equal((await engine.tick()).observation, "unavailable"); assert.equal(lab.creates.length, 1); assert.equal((await engine.read())?.action.deadline, 91000);
  lab.observed({ status: "absent" }); assert.equal((await engine.inspect(101000)).status, "absent"); assert.equal(lab.creates.length, 1);
  await assert.rejects(engine.inspect(111000), /observation deadline/);
});

test("current authorization and its final deadline check precede every native effect", async (t) => {
  const lab = await fixture(t); lab.allowed(false); const { engine } = await lab.open(); await engine.prepare(lab.request);
  assert.equal((await engine.tick()).state.reason, "unauthorized"); assert.equal(lab.creates.length, 0);
  const other = await fixture(t); const opened = await other.open(undefined, { authorize: () => { other.time(91000); return Promise.resolve(true); } }); const bounded = opened.engine; await bounded.prepare(other.request);
  assert.equal((await bounded.tick()).state.reason, "deadline"); assert.equal(other.creates.length, 0);
});

test("concurrent ticks share one synchronized intent and do not duplicate native creation", async (t) => {
  const lab = await fixture(t); const { engine } = await lab.open(); await engine.prepare(lab.request); const results = await Promise.all([engine.tick(), engine.tick(), engine.tick()]);
  assert.equal(results.at(-1)?.state.phase, "ready"); assert.equal(lab.creates.length, 1);
});

test("unavailable runtime observations never justify creation and eventually preserve the original expiry", async (t) => {
  const lab = await fixture(t); lab.observed({ status: "unavailable" }); const { engine } = await lab.open(); await engine.prepare(lab.request);
  assert.equal((await engine.tick()).observation, "unavailable"); assert.equal(lab.creates.length, 0); lab.time(91000);
  assert.equal((await engine.tick()).state.reason, "deadline"); assert.equal(lab.creates.length, 0);
});

test("contradictory, secret-bearing or corrupt creation records fail before any runtime call", async (t) => {
  const lab = await fixture(t); const { engine, journal } = await lab.open(); const initial = await engine.prepare(lab.request);
  for (const changed of [{ ...initial, resolvedSecrets: { PASSWORD: "private" } }, { ...initial, phase: "ready", receipt: null }, { ...initial, phase: "held", reason: "missing" }, { ...initial, action: { ...initial.action, deadline: initial.createdAt + 90001 } }]) assert.throws(() => parseDataVolumeCreation(changed), /volume creation state/);
  await journal.write({ invalid: true }); await assert.rejects(engine.tick(), /invalid volume creation state/); assert.equal(lab.creates.length, 0);
});


test("a delayed authorization cannot hang past its deadline or dispatch after resolving late", async (t) => {
  const lab = await fixture(t); const gate = Promise.withResolvers<boolean>();
  const { engine } = await lab.open(undefined, { authorize: () => gate.promise });
  await engine.prepare({ ...lab.request, action: { ...lab.request.action, deadline: 1050 } });
  const pending = await engine.tick(); assert.equal(pending.observation, "unavailable"); assert.equal(lab.creates.length, 0);
  lab.time(1050); gate.resolve(true); assert.equal((await engine.tick()).state.reason, "deadline"); assert.equal(lab.creates.length, 0);
});

test("idempotent retries use the same allocation/action/deadline and stop at the finite attempt ceiling", async (t) => {
  const lab = await fixture(t); const calls: VolumeAction[] = [];
  const { engine } = await lab.open(undefined, { native: { ...lab.ports.native, create: (action) => { calls.push(action); return Promise.resolve("uncertain"); } } });
  await engine.prepare(lab.request);
  for (let attempt = 0; attempt < 8; attempt++) await engine.tick();
  const held = await engine.tick(); assert.equal(held.state.reason, "attempts"); assert.equal(calls.length, 8);
  assert.ok(calls.every((action) => JSON.stringify(action) === JSON.stringify(lab.request.action)));
  await engine.tick(); assert.equal(calls.length, 8);
});
