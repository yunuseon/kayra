import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JournalValue } from "../../src/server/deployment/journal.ts";
import { openLifecycleEnvelopeStore } from "../../src/server/deployment/lifecycle-envelope-store.ts";
import { openLifecycleFenceStore } from "../../src/server/deployment/lifecycle-fence-store.ts";
import { openLedger } from "../../src/server/deployment/ledger.ts";
import { singleEffectCoordinator } from "../../src/server/deployment/operation.ts";

const initial = { capacity: { cpu: 4000, memory: 400 }, platform: { cpu: 1000, memory: 100 }, workloads: [], reservations: [] };
const port = { authorize: () => Promise.resolve(false), execute: () => Promise.resolve(), observe: () => Promise.reject(new Error("not used")) };

test("all prototype consumers exclude each other on the same journal object", async () => {
  for (const first of ["fence", "envelope", "ledger", "operation"] as const) {
    // eslint-disable-next-line functional/no-let -- local fake journal state
    let state: JournalValue | undefined;
    const journal = { read: () => Promise.resolve(state), write: (value: JournalValue) => { state = value; return Promise.resolve(); } };
    if (first === "fence") openLifecycleFenceStore(journal);
    if (first === "envelope") openLifecycleEnvelopeStore(journal);
    if (first === "ledger") await openLedger(journal, initial, () => 0);
    if (first === "operation") singleEffectCoordinator(journal, port, () => 0);
    assert.throws(() => openLifecycleFenceStore(journal), /already owned/);
    assert.throws(() => openLifecycleEnvelopeStore(journal), /already owned/);
    assert.throws(() => singleEffectCoordinator(journal, port, () => 0), /already has a coordinator/);
    await assert.rejects(openLedger(journal, initial, () => 0), /already owned/);
  }
});

test("a ledger open failing before any write releases its shared claim", async () => {
  const journal = { read: () => Promise.resolve(undefined), write: () => Promise.resolve() };
  await assert.rejects(openLedger(journal, { ...initial, capacity: { cpu: 0, memory: 400 } }, () => 0), /invalid initial admission/);
  assert.doesNotThrow(() => openLifecycleEnvelopeStore(journal));
});

test("an ambiguous ledger initialization write retains its claim and requires a fresh handle", async () => {
  // eslint-disable-next-line functional/no-let -- simulate a durable write with lost acknowledgement
  let state: JournalValue | undefined;
  const journal = { read: () => Promise.resolve(state), write: (value: JournalValue) => { state = value; return Promise.reject(new Error("lost acknowledgement")); } };
  await assert.rejects(openLedger(journal, initial, () => 0), /lost acknowledgement/);
  await assert.rejects(openLedger(journal, initial, () => 0), /already owned/);
  assert.throws(() => openLifecycleFenceStore(journal), /already owned/);
  // A fresh handle represents a separately closed/reopened journal; in real use
  // its provider must enforce the OS lock and reconcile persisted state.
  const reopened = { read: () => Promise.resolve(state), write: () => Promise.resolve() };
  const ledger = await openLedger(reopened, initial, () => 0);
  assert.deepEqual(await ledger.recoveries(), []);
});

test("another consumer cannot claim while ledger initialization awaits I/O", async () => {
  // eslint-disable-next-line functional/no-let -- expose resolution of a delayed journal read
  let resume: ((value: undefined) => void) | undefined;
  const waiting = new Promise<undefined>((resolve) => { resume = resolve; });
  const journal = { read: () => waiting, write: () => Promise.resolve() };
  const opening = openLedger(journal, initial, () => 0);
  assert.throws(() => openLifecycleEnvelopeStore(journal), /already owned/);
  if (resume === undefined) throw new Error("missing journal resolver");
  resume(undefined);
  await opening;
  assert.throws(() => openLifecycleFenceStore(journal), /already owned/);
});

test("a ledger read failure before initialization permits a new owner", async () => {
  const journal = { read: () => Promise.reject(new Error("read failed")), write: () => Promise.resolve() };
  await assert.rejects(openLedger(journal, initial, () => 0), /read failed/);
  assert.doesNotThrow(() => openLifecycleEnvelopeStore(journal));
});
