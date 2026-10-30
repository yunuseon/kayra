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
const journalUrl = new URL('../../src/server/deployment/journal.ts', import.meta.url).href;
const storeUrl = new URL('../../src/server/deployment/lifecycle-envelope-store.ts', import.meta.url).href;
const childSource = `
import { openJournal } from ${JSON.stringify(journalUrl)};
import { openLifecycleEnvelopeStore } from ${JSON.stringify(storeUrl)};
const journal = await openJournal(process.argv[1]);
const store = openLifecycleEnvelopeStore(journal);
await store.initialize('shop', ${JSON.stringify(incarnation)});
const ticket = await store.reserveRegistration();
if (ticket !== ${JSON.stringify(`${incarnation}:1`)}) throw new Error('unexpected ticket');
if (process.argv[2] === 'submitted') {
  const submission = await store.submitRegistration(ticket, ${JSON.stringify(registration)});
  if (submission.status !== 'new') throw new Error('unexpected submission');
}
console.log('ready');
setInterval(() => { void store.read(); }, 1000);
`;

test('a killed writer preserves reservation and combined registration intent', async () => {
  for (const phase of ['reserved', 'submitted'] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'kayra-envelope-crash-'));
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', childSource, dir, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    try {
      const data: unknown = await Promise.race([
        once(lines, 'line').then((args: readonly unknown[]) => args[0]),
        once(child, 'exit').then(() => { throw new Error(`writer exited before ${phase}`); }),
      ]);
      assert.equal(data, 'ready');
      await assert.rejects(openJournal(dir), /locked/);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const journal = await openJournal(dir);
      const store = openLifecycleEnvelopeStore(journal);
      const state = await store.read();
      assert.ok(state !== undefined);
      assert.equal(state.created, phase === 'submitted');
      assert.equal(state.tickets.active[0]?.phase, phase === 'submitted' ? 'accepted' : 'reserved');
      assert.equal(state.tickets.active[0].sequence, 1);
      assert.equal(state.fence?.lifecycle.phase, phase === 'submitted' ? 'registering' : undefined);
      assert.equal(state.operations.length, phase === 'submitted' ? 1 : 0);
      const response = await store.submitRegistration(`${incarnation}:1`, registration);
      assert.deepEqual(response, { status: phase === 'submitted' ? 'reconcile' : 'new', actionId: `${incarnation}:1` });
      await assert.rejects(store.submitRegistration(`${incarnation}:1`, incarnation), /conflict/);
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
