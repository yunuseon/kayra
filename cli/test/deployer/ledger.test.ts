import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openJournal } from '../../src/server/deployment/journal.ts';
import { openLedger } from '../../src/server/deployment/ledger.ts';
import { singleEffectCoordinator, type OperationRequest } from '../../src/server/deployment/operation.ts';

const initial = { capacity: { cpu: 4000, memory: 400 }, platform: { cpu: 1000, memory: 100 }, workloads: [], reservations: [] };
const budget = { cpu: 1000, memory: 100 };
const req = (digit: string): OperationRequest => ({ operationId: `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`, actionId: `f${digit.repeat(7)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`, planDigest: 'a'.repeat(64), deadline: 9000, replay: 'never' });

test('a failed open releases its claim but concurrent opens remain excluded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kayra-ledger-'));
  try {
    const journal = await openJournal(dir);
    await assert.rejects(openLedger(journal, { ...initial, capacity: { cpu: 0, memory: 400 } }, () => 1000), /invalid initial admission/);
    const opening = openLedger(journal, initial, () => 1000);
    await assert.rejects(openLedger(journal, initial, () => 1000), /already owned/);
    const ledger = await opening;
    await ledger.admit('alpha', req('1'), budget);
    assert.equal((await ledger.recoveries()).length, 1);
    await journal.close();

    const reopened = await openJournal(dir);
    await assert.rejects(openLedger(reopened, { ...initial, capacity: { cpu: 1000, memory: 100 } }, () => 1000), /reconciliation/);
    const recovered = await openLedger(reopened, initial, () => 1000);
    assert.equal((await recovered.recoveries()).length, 1);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('requesting an unadmitted handle does not consume it before or during admission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kayra-ledger-'));
  try {
    const journal = await openJournal(dir);
    const ledger = await openLedger(journal, initial, () => 1000);
    const operationId = req('1').operationId;
    assert.throws(() => ledger.journalFor(operationId), /not admitted/);
    const admitting = ledger.admit('alpha', req('1'), budget);
    assert.throws(() => ledger.journalFor(operationId), /not admitted/);
    await admitting;
    const handle = ledger.journalFor(operationId);
    assert.equal(await handle.read(), undefined);
    assert.throws(() => ledger.journalFor(operationId), /already owned/);
    await journal.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a confirmed exact retry exposes an admission whose write acknowledgement was lost', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kayra-ledger-'));
  try {
    const raw = await openJournal(dir);
    // eslint-disable-next-line functional/no-let -- simulates one lost write acknowledgement
    let loseAcknowledgement = false;
    const journal = {
      read: raw.read,
      write: async (value: Parameters<typeof raw.write>[0]) => {
        await raw.write(value);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error('acknowledgement lost');
        }
      },
    };
    const ledger = await openLedger(journal, initial, () => 1000);
    loseAcknowledgement = true;
    await assert.rejects(ledger.admit('alpha', req('1'), budget), /acknowledgement lost/);
    assert.throws(() => ledger.journalFor(req('1').operationId), /not admitted/);
    await assert.rejects(ledger.admit('alpha', req('1'), { ...budget, cpu: 1100 }), /conflicting/);
    assert.throws(() => ledger.journalFor(req('1').operationId), /not admitted/);
    await ledger.admit('alpha', req('1'), budget);
    assert.equal(await ledger.journalFor(req('1').operationId).read(), undefined);
    await raw.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent admissions charge capacity once and reject the losing request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kayra-ledger-'));
  try {
    const journal = await openJournal(dir);
    const ledger = await openLedger(journal, initial, () => 1000);
    const results = await Promise.allSettled([
      ledger.admit('alpha', req('1'), { cpu: 2000, memory: 200 }),
      ledger.admit('beta', req('2'), { cpu: 2000, memory: 200 }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal((await ledger.recoveries()).length, 1);
    await journal.close();
    const reopened = await openJournal(dir);
    const recovered = await openLedger(reopened, initial, () => 1000);
    assert.equal((await recovered.recoveries()).length, 1);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('multiple admissions persist intent before effects and publish only restricted projections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kayra-ledger-'));
  try {
    const journal = await openJournal(dir);
    const ledger = await openLedger(journal, initial, () => 1000);
    await Promise.all([ledger.admit('alpha', req('1'), budget), ledger.admit('beta', req('2'), budget)]);
    const action = singleEffectCoordinator(ledger.journalFor(req('1').operationId), {
      authorize: (record) => Promise.resolve(record.planDigest === 'a'.repeat(64) && record.replay === 'never'),
      execute: async () => {
        const views = await ledger.projections();
        assert.equal(views.find((entry) => entry.app === 'alpha')?.phase, 'intent');
      },
      observe: (record) => Promise.resolve({ operationId: record.operationId, actionId: record.actionId, planDigest: record.planDigest, status: 'applied' as const }),
    }, () => 1000);
    assert.equal((await action.start(req('1'))).kind, 'pending');
    assert.equal((await action.reconcile()).kind, 'verified');
    assert.deepEqual((await ledger.projections()).map((item) => item.phase), ['verified', 'admitted']);
    assert.throws(() => ledger.journalFor(req('1').operationId), /already owned/);
    await assert.rejects(ledger.admit('alpha', req('3'), budget), /already has a lease/);
    await journal.close();
    const reopened = await openJournal(dir);
    const recovered = await openLedger(reopened, initial, () => 12000);
    assert.deepEqual((await recovered.projections()).map((item) => [item.phase, item.deadline]), [['verified', 9000], ['admitted', 9000]]);
    await assert.rejects(recovered.admit('gamma', { ...req('3'), deadline: 14000 }, { cpu: 2000, memory: 200 }), /capacity/);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('admission snapshots inputs and exact retries are idempotent even after restart and deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kayra-ledger-'));
  try {
    const journal = await openJournal(dir);
    const ledger = await openLedger(journal, initial, () => 1000);
    const original = req('1');
    const mutableRequest = { ...original };
    const mutableBudget = { ...budget };
    const accepted = ledger.admit('alpha', mutableRequest, mutableBudget);
    // eslint-disable-next-line functional/immutable-data -- exercise mutation after invocation
    mutableRequest.deadline = 14000;
    // eslint-disable-next-line functional/immutable-data -- exercise mutation after invocation
    mutableRequest.actionId = req('2').actionId;
    // eslint-disable-next-line functional/immutable-data -- exercise mutation after invocation
    mutableBudget.cpu = 2000;
    await accepted;
    const [entry] = await ledger.recoveries();
    assert.deepEqual(entry?.request, original);
    assert.deepEqual(entry.lease.budget, budget);
    assert.equal(Object.isFrozen(entry.request), true);
    await journal.close();

    const reopened = await openJournal(dir);
    const recovered = await openLedger(reopened, initial, () => 12000);
    await recovered.admit('alpha', original, budget);
    assert.equal((await recovered.recoveries()).length, 1);
    await assert.rejects(recovered.admit('other', original, budget), /conflicting/);
    await assert.rejects(recovered.admit('alpha', { ...original, deadline: 14000 }, budget), /conflicting/);
    await assert.rejects(recovered.admit('alpha', { ...original, planDigest: 'b'.repeat(64) }, budget), /conflicting/);
    await assert.rejects(recovered.admit('alpha', original, { ...budget, cpu: 1100 }), /conflicting/);
    assert.deepEqual((await recovered.recoveries())[0]?.request, original);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('corrupt or conflicting state and unauthorized plans fail closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kayra-ledger-'));
  try {
    const journal = await openJournal(dir);
    const ledger = await openLedger(journal, initial, () => 1000);
    await ledger.admit('alpha', req('1'), budget);
    const port = ledger.journalFor(req('1').operationId);
    await assert.rejects(port.write({ ...req('1'), actionId: req('2').actionId, version: 1, attempts: 1, phase: 'intent' }), /admission/);
    const action = singleEffectCoordinator(port, {
      authorize: () => Promise.resolve(false),
      execute: () => Promise.reject(new Error('must not execute')),
      observe: (record) => Promise.resolve({ operationId: record.operationId, actionId: record.actionId, planDigest: record.planDigest, status: 'unknown' as const }),
    }, () => 1000);
    assert.equal((await action.start(req('1'))).kind, 'held');
    assert.equal((await ledger.projections())[0]?.requiredAction, 'unauthorized');
    await journal.close();
    const reopened = await openJournal(dir);
    await assert.rejects(openLedger(reopened, { ...initial, capacity: { cpu: 1000, memory: 100 } }, () => 1000), /reconciliation/);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('operation writes snapshot validated outcomes before the async queue runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kayra-ledger-'));
  try {
    const journal = await openJournal(dir);
    const ledger = await openLedger(journal, initial, () => 1000);
    await ledger.admit('alpha', req('1'), budget);
    const port = ledger.journalFor(req('1').operationId);
    await port.write({ ...req('1'), version: 1, attempts: 1, phase: 'intent' });
    const mutable = { ...req('1'), version: 1, attempts: 1, phase: 'held', reason: 'ambiguous' };
    const pending = port.write(mutable);
    // eslint-disable-next-line functional/immutable-data -- attempt to alter a queued outcome
    Object.assign(mutable, { phase: 'verified', reason: undefined });
    await pending;
    assert.deepEqual(await ledger.projections(), [{ app: 'alpha', operationId: req('1').operationId, phase: 'held', deadline: 9000, requiredAction: 'ambiguous' }]);
    await journal.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restart after SIGKILL just after admission keeps the unstarted request and lease', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kayra-ledger-'));
  const journalUrl = new URL('../../src/server/deployment/journal.ts', import.meta.url).href;
  const ledgerUrl = new URL('../../src/server/deployment/ledger.ts', import.meta.url).href;
  const source = `import {openJournal} from ${JSON.stringify(journalUrl)}; import {openLedger} from ${JSON.stringify(ledgerUrl)}; const j=await openJournal(process.argv[1]); const ledger=await openLedger(j,${JSON.stringify(initial)},()=>1000); await ledger.admit('alpha',${JSON.stringify(req('1'))},${JSON.stringify(budget)}); console.log('admitted'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', source, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const data: unknown = await Promise.race([once(child.stdout, 'data').then((args: readonly unknown[]) => args[0]), once(child, 'exit').then(() => { throw new Error('writer exited before admission'); })]);
    assert.equal(String(data).trim(), 'admitted');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const journal = await openJournal(dir);
    const ledger = await openLedger(journal, initial, () => 12000);
    assert.deepEqual(await ledger.projections(), [{ app: 'alpha', operationId: req('1').operationId, phase: 'admitted', deadline: 9000 }]);
    const [entry] = await ledger.recoveries();
    assert.deepEqual(entry?.request, req('1'));
    assert.equal(entry.record, null);
    assert.equal(entry.lease.deadline, 9000);
    assert.deepEqual(entry.lease.budget, budget);
    const port = ledger.journalFor(req('1').operationId);
    assert.equal(await port.read(), undefined);
    // eslint-disable-next-line functional/prefer-immutable-types -- record whether any adapter method ran
    const calls: string[] = [];
    const expired = singleEffectCoordinator(port, {
      authorize: () => {
        // eslint-disable-next-line functional/immutable-data -- record adapter calls
        calls.push('authorize');
        return Promise.resolve(true);
      },
      execute: () => {
        // eslint-disable-next-line functional/immutable-data -- record adapter calls
        calls.push('execute');
        return Promise.resolve();
      },
      observe: (record) => {
        // eslint-disable-next-line functional/immutable-data -- record adapter calls
        calls.push('observe');
        return Promise.resolve({ operationId: record.operationId, actionId: record.actionId, planDigest: record.planDigest, status: 'unknown' as const });
      },
    }, () => 12000);
    await assert.rejects(expired.start(req('1')), /deadline has expired/);
    assert.deepEqual(calls, []);
    assert.equal((await ledger.recoveries())[0]?.record, null);
    await ledger.expireUnstarted(req('1').operationId);
    assert.deepEqual(await ledger.projections(), [{ app: 'alpha', operationId: req('1').operationId, phase: 'held', deadline: 9000, requiredAction: 'expired' }]);
    assert.equal((await ledger.recoveries())[0]?.record?.deadline, 9000);
    await assert.rejects(ledger.expireUnstarted(req('1').operationId), /already has a recorded/);
    await assert.rejects(ledger.admit('beta', { ...req('2'), deadline: 14000 }, { cpu: 3000, memory: 300 }), /capacity/);
    await journal.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('unstarted expiry refuses early, unknown, and already-intended operations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kayra-ledger-'));
  try {
    const journal = await openJournal(dir);
    // eslint-disable-next-line functional/no-let -- advance the clock around the deadline
    let now = 1000;
    const ledger = await openLedger(journal, initial, () => now);
    await ledger.admit('alpha', req('1'), budget);
    await assert.rejects(ledger.expireUnstarted(req('1').operationId), /has not expired/);
    await assert.rejects(ledger.expireUnstarted(req('2').operationId), /not admitted/);
    await ledger.journalFor(req('1').operationId).write({ ...req('1'), version: 1, attempts: 1, phase: 'intent' });
    now = 9000;
    await assert.rejects(ledger.expireUnstarted(req('1').operationId), /already has a recorded/);
    assert.equal((await ledger.recoveries())[0]?.record?.phase, 'intent');
    await journal.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('expiry and an intent write serialize, preserving whichever won across restart', async () => {
  for (const expiryFirst of [true, false]) {
    const dir = await mkdtemp(join(tmpdir(), 'kayra-ledger-'));
    try {
      const journal = await openJournal(dir);
      // eslint-disable-next-line functional/no-let -- advance past the original deadline after admission
      let now = 1000;
      const ledger = await openLedger(journal, initial, () => now);
      await ledger.admit('alpha', req('1'), budget);
      const handle = ledger.journalFor(req('1').operationId);
      now = 9000;
      const expire = () => ledger.expireUnstarted(req('1').operationId);
      const write = () => handle.write({ ...req('1'), version: 1, attempts: 1, phase: 'intent' });
      const results = await Promise.allSettled(expiryFirst ? [expire(), write()] : [write(), expire()]);
      assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected']);
      await journal.close();
      const reopened = await openJournal(dir);
      const restored = await openLedger(reopened, initial, () => now);
      const [entry] = await restored.recoveries();
      assert.equal(entry?.record?.phase, expiryFirst ? 'held' : 'intent');
      assert.equal(entry.record.deadline, 9000);
      assert.deepEqual(entry.lease.budget, budget);
      await reopened.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('restart before the deadline starts an admitted operation only after authorization', async () => {
  for (const allow of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'kayra-ledger-'));
    const journalUrl = new URL('../../src/server/deployment/journal.ts', import.meta.url).href;
    const ledgerUrl = new URL('../../src/server/deployment/ledger.ts', import.meta.url).href;
    const source = `import {openJournal} from ${JSON.stringify(journalUrl)}; import {openLedger} from ${JSON.stringify(ledgerUrl)}; const j=await openJournal(process.argv[1]); const ledger=await openLedger(j,${JSON.stringify(initial)},()=>1000); await ledger.admit('alpha',${JSON.stringify(req('1'))},${JSON.stringify(budget)}); console.log('admitted'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', source, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const data: unknown = await Promise.race([once(child.stdout, 'data').then((args: readonly unknown[]) => args[0]), once(child, 'exit').then(() => { throw new Error('writer exited before admission'); })]);
      assert.equal(String(data).trim(), 'admitted');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const journal = await openJournal(dir);
      const ledger = await openLedger(journal, initial, () => 2000);
      const [entry] = await ledger.recoveries();
      assert.deepEqual(entry?.request, req('1'));
      assert.equal(entry.record, null);
      // eslint-disable-next-line functional/prefer-immutable-types -- record adapter calls and their order
      const calls: string[] = [];
      const coordinator = singleEffectCoordinator(ledger.journalFor(entry.request.operationId), {
        authorize: (record) => {
          // eslint-disable-next-line functional/immutable-data -- record adapter calls and their order
          calls.push('authorize');
          assert.equal(record.planDigest, 'a'.repeat(64));
          assert.equal(record.deadline, 9000);
          assert.equal(record.replay, 'never');
          return Promise.resolve(allow);
        },
        execute: () => {
          // eslint-disable-next-line functional/immutable-data -- record adapter calls and their order
          calls.push('execute');
          return Promise.resolve();
        },
        observe: () => Promise.reject(new Error('must not observe an unstarted action')),
      }, () => 2000);
      const result = await coordinator.start(entry.request);
      assert.equal(result.kind, allow ? 'pending' : 'held');
      assert.deepEqual(calls, allow ? ['authorize', 'execute'] : ['authorize']);
      assert.equal((await ledger.recoveries())[0]?.request.deadline, 9000);
      await journal.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('refuses a syntactically valid ledger with an unbacked operation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kayra-ledger-'));
  try {
    const journal = await openJournal(dir);
    await journal.write({ version: 1, admission: initial, operations: [{ app: 'alpha', request: req('1'), record: null }] });
    await journal.close();
    const reopened = await openJournal(dir);
    await assert.rejects(openLedger(reopened, initial, () => 1000), /invalid lifecycle ledger/);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restart after killing an executing process preserves intent, identity, deadline and lease', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kayra-ledger-'));
  const journalUrl = new URL('../../src/server/deployment/journal.ts', import.meta.url).href;
  const ledgerUrl = new URL('../../src/server/deployment/ledger.ts', import.meta.url).href;
  const operationUrl = new URL('../../src/server/deployment/operation.ts', import.meta.url).href;
  const source = `import {openJournal} from ${JSON.stringify(journalUrl)}; import {openLedger} from ${JSON.stringify(ledgerUrl)}; import {singleEffectCoordinator} from ${JSON.stringify(operationUrl)}; const j=await openJournal(process.argv[1]); const ledger=await openLedger(j,${JSON.stringify(initial)},()=>1000); const r=${JSON.stringify(req('1'))}; await ledger.admit('alpha',r,${JSON.stringify(budget)}); const c=singleEffectCoordinator(ledger.journalFor(r.operationId),{authorize:async()=>true,execute:async()=>{console.log('effect'); await new Promise(()=>{});},observe:async()=>{throw Error('not called')}},()=>1000); await c.start(r);`;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', source, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const data: unknown = await Promise.race([once(child.stdout, 'data').then((args: readonly unknown[]) => args[0]), once(child, 'exit').then(() => { throw new Error('writer exited before effect'); })]);
    assert.equal(String(data).trim(), 'effect');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const journal = await openJournal(dir);
    const ledger = await openLedger(journal, initial, () => 12000);
    assert.deepEqual(await ledger.projections(), [{ app: 'alpha', operationId: req('1').operationId, phase: 'intent', deadline: 9000 }]);
    const recovery = singleEffectCoordinator(ledger.journalFor(req('1').operationId), {
      authorize: () => Promise.reject(new Error('must not authorize a replay')),
      execute: () => Promise.reject(new Error('must not replay')),
      observe: (record) => Promise.resolve({ operationId: record.operationId, actionId: record.actionId, planDigest: record.planDigest, status: 'unknown' as const }),
    }, () => 12000);
    assert.equal((await recovery.reconcile(13000)).kind, 'held');
    assert.deepEqual(await ledger.projections(), [{ app: 'alpha', operationId: req('1').operationId, phase: 'held', deadline: 9000, requiredAction: 'unavailable' }]);
    await assert.rejects(ledger.admit('beta', { ...req('2'), deadline: 14000 }, { cpu: 3000, memory: 300 }), /capacity/);
    await journal.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
