import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { openJournal } from '../../src/server/deployment/journal.ts';
import { openLifecycleEnvelopeStore } from '../../src/server/deployment/lifecycle-envelope-store.ts';

const incarnation = '11111111-1111-4111-8111-111111111111';
const registration = '22222222-2222-4222-8222-222222222222';
const ticket = `${incarnation}:1`;
const journalUrl = new URL('../../src/server/deployment/journal.ts', import.meta.url).href;
const storeUrl = new URL('../../src/server/deployment/lifecycle-envelope-store.ts', import.meta.url).href;
const source = `
import { openJournal } from ${JSON.stringify(journalUrl)};
import { openLifecycleEnvelopeStore } from ${JSON.stringify(storeUrl)};
const journal = await openJournal(process.argv[1]);
let pauseAfterWrite = false;
const wrapped = {
  read: () => journal.read(),
  write: async (state) => {
    await journal.write(state);
    if (pauseAfterWrite) { console.log('ready'); await new Promise(() => {}); }
  },
};
const store = openLifecycleEnvelopeStore(wrapped, async expected => ({ ...expected, status: 'applied' }));
await store.initialize('shop', ${JSON.stringify(incarnation)});
const ticket = await store.reserveRegistration();
await store.submitRegistration(ticket, ${JSON.stringify(registration)});
setInterval(() => { void store.read(); }, 1000);
if (process.argv[2] === 'before') console.log('ready');
else {
  pauseAfterWrite = process.argv[2] === 'lost-ack';
  const result = await store.reconcileRegistration(ticket, ${JSON.stringify(registration)});
  if (result.status !== 'verified') throw new Error('unexpected completion');
  console.log('ready');
}
`;

test('registration completion remains coherent across process termination and lost acknowledgement', async () => {
  for (const phase of ['before', 'lost-ack', 'acknowledged'] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'kayra-registration-completion-'));
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', source, dir, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    try {
      const ready: unknown = await Promise.race([
        once(lines, 'line').then((args: readonly unknown[]) => args[0]),
        once(child, 'exit').then(() => { throw new Error(`writer exited before ${phase}`); }),
      ]);
      assert.equal(ready, 'ready');
      await assert.rejects(openJournal(dir), /locked/);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const journal = await openJournal(dir);
      // eslint-disable-next-line functional/no-let -- count trusted observations during reconciliation
      let observations = 0;
      const store = openLifecycleEnvelopeStore(journal, (expected) => {
        observations += 1;
        return Promise.resolve({ ...expected, status: 'applied' });
      });
      const state = await store.read();
      assert.ok(state !== undefined);
      assert.equal(state.created, true);
      if (phase === 'before') {
        assert.equal(state.fence?.lifecycle.phase, 'registering');
        assert.equal(state.tickets.active[0]?.phase, 'accepted');
        assert.equal(state.tickets.receipts.length, 0);
        assert.equal(state.operations.length, 1);
        assert.deepEqual(await store.reconcileRegistration(ticket, registration), { status: 'verified' });
        assert.equal(observations, 1);
      } else {
        assert.deepEqual(state.fence?.lifecycle, { phase: 'registered', active: null });
        assert.equal(state.tickets.active.length, 0);
        assert.equal(state.tickets.receipts[0]?.outcome, 'success');
        assert.equal(state.operations.length, 0);
      }
      assert.deepEqual(await store.reconcileRegistration(ticket, registration), { status: 'terminal', outcome: 'success' });
      assert.equal(observations, phase === 'before' ? 1 : 0);
      await journal.close();
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      await rm(dir, { recursive: true, force: true });
    }
  }
});
