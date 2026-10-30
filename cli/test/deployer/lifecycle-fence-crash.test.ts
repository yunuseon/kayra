import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { openJournal } from '../../src/server/deployment/journal.ts';
import { lifecycleActionId } from '../../src/server/deployment/lifecycle-fence.ts';
import { openLifecycleFenceStore } from '../../src/server/deployment/lifecycle-fence-store.ts';

const moduleUrl = new URL('../../src/server/deployment/lifecycle-fence.ts', import.meta.url).href;
const journalUrl = new URL('../../src/server/deployment/journal.ts', import.meta.url).href;
const storeUrl = new URL('../../src/server/deployment/lifecycle-fence-store.ts', import.meta.url).href;
const childSource = `
import { openJournal } from ${JSON.stringify(journalUrl)};
import { lifecycleActionId } from ${JSON.stringify(moduleUrl)};
import { openLifecycleFenceStore } from ${JSON.stringify(storeUrl)};
const journal = await openJournal(process.argv[1]);
const store = openLifecycleFenceStore(journal);
let state = await store.initialize('shop', '12345678-1234-1234-1234-123456789abc');
if (process.argv[2] !== 'registering') {
  state = await store.settle(lifecycleActionId(state, 1));
  state = await store.beginWork('deploy');
}
if (['removal-requested', 'removing', 'purging'].includes(process.argv[2])) {
  state = await store.requestRemoval();
}
if (['removing', 'purging'].includes(process.argv[2])) {
  state = await store.settle(lifecycleActionId(state, 2));
  state = await store.startRemoval(() => Promise.resolve(['shop_db']));
}
if (process.argv[2] === 'purging') {
  state = await store.completeRemoval(lifecycleActionId(state, 3));
  state = await store.startPurge(lifecycleActionId(state, 3));
}
console.log('ready');
setInterval(() => { void store.read(); }, 1000);
`;

test('an interrupted lifecycle intent is still fenced after the writer is killed', async () => {
  for (const phase of ['registering', 'deploying', 'removal-requested', 'removing', 'purging'] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'kayra-fence-crash-'));
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', childSource, dir, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    try {
      const data: unknown = await Promise.race([
        once(lines, 'line').then((args: readonly unknown[]) => args[0]),
        once(child, 'exit').then(() => { throw new Error(`writer exited before ${phase}`); }),
      ]);
      assert.equal(String(data).trim(), 'ready');
      await assert.rejects(openJournal(dir), /locked/);
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const journal = await openJournal(dir);
      const store = openLifecycleFenceStore(journal);
      const state = await store.read();
      assert.ok(state !== undefined);
      assert.equal(state.app, 'shop');
      assert.equal(state.generation, '12345678-1234-1234-1234-123456789abc');
      assert.equal(state.lifecycle.phase, phase === 'deploying' ? 'registered' : phase);
      if (state.lifecycle.phase === 'registering') assert.deepEqual(state.lifecycle.active, { kind: 'register', sequence: 1 });
      if (state.lifecycle.phase === 'registered' || state.lifecycle.phase === 'removal-requested') {
        assert.deepEqual(state.lifecycle.active, { kind: 'deploy', sequence: 2 });
      }
      if (state.lifecycle.phase === 'removal-requested' || state.lifecycle.phase === 'removing') assert.equal(state.lifecycle.removal, 3);
      if (state.lifecycle.phase === 'purging') {
        assert.equal(state.lifecycle.tombstone.removal, 3);
        assert.equal(state.lifecycle.purge, 4);
      }
      await assert.rejects(store.beginRegistration());
      await assert.rejects(store.beginWork('deploy'));
      await assert.rejects(store.beginWork('restore'));
      await assert.rejects(store.startPurge(lifecycleActionId(state, 3)));
      await assert.rejects(store.completeRemoval(lifecycleActionId(state, 99)));
      await assert.rejects(store.completePurge(lifecycleActionId(state, 99)));
      if (phase === 'removal-requested') {
        await assert.rejects(store.startRemoval(() => Promise.resolve(['shop_db'])));
        const settled = await store.settle(lifecycleActionId(state, 2));
        assert.equal(settled.lifecycle.phase, 'removal-requested');
      }
      if (phase === 'removing' || phase === 'purging') {
        assert.deepEqual(state.lifecycle.phase === 'removing' ? state.lifecycle.volumes : state.lifecycle.phase === 'purging' ? state.lifecycle.tombstone.volumes : [], ['shop_db']);
      }
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
