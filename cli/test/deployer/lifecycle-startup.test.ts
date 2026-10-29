import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openJournal } from '../../src/server/deployment/journal.ts';
import { startWithLifecycle } from '../../src/server/deployment/startup.ts';

const temporary = () => mkdtemp(join(tmpdir(), 'kayra-startup-'));

test('starts only after acquiring the writer lock and refuses a second owner', async () => {
  const dir = await temporary();
  try {
    // eslint-disable-next-line functional/no-let -- records whether the startup callback ran
    let starts = 0;
    const start = () => {
      starts += 1;
    };
    const journal = await startWithLifecycle(dir, start);
    assert.equal(starts, 1);
    assert.deepEqual(await journal.read(), { version: 1, mode: 'legacy-compose-lock-only' });
    await assert.rejects(startWithLifecycle(dir, start), /locked/);
    assert.equal(starts, 1);
    await journal.close();
    const next = await startWithLifecycle(dir, start);
    assert.equal(starts, 2);
    await next.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('corrupt, missing or unsupported journal state never starts the daemon', async () => {
  const dir = await temporary();
  try {
    // eslint-disable-next-line functional/no-let -- records whether the startup callback ran
    let starts = 0;
    const start = () => {
      starts += 1;
    };
    const journal = await openJournal(dir);
    await journal.write({ version: 99 });
    await journal.close();
    await assert.rejects(startWithLifecycle(dir, start), /unsupported or corrupt/);
    assert.equal(starts, 0);
    await writeFile(join(dir, 'state.json'), '{broken');
    await assert.rejects(startWithLifecycle(dir, start), SyntaxError);
    assert.equal(starts, 0);
    await rm(join(dir, 'state.json'));
    await assert.rejects(startWithLifecycle(dir, start), /disagree/);
    assert.equal(starts, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('partial startup retains the lock while its listener survives a caught exception', async () => {
  const dir = await temporary();
  const moduleUrl = new URL('../../src/server/deployment/startup.ts', import.meta.url).href;
  const source = `import { createServer } from 'node:http';
import { startWithLifecycle } from ${JSON.stringify(moduleUrl)};
const server = createServer();
try {
  await startWithLifecycle(process.argv[1], () => { server.listen(0); throw new Error('partial startup'); });
} catch {}
const second = await startWithLifecycle(process.argv[1], () => {}).then(() => 'admitted', () => 'locked');
console.log(JSON.stringify({ listening: server.listening, second }));
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', source, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const data: unknown = await Promise.race([
      once(child.stdout, 'data').then((args: readonly unknown[]) => args[0]),
      once(child, 'exit').then(() => { throw new Error('startup process exited before reporting'); }),
    ]);
    assert.deepEqual(JSON.parse(String(data)), { listening: true, second: 'locked' });
    await assert.rejects(openJournal(dir), /locked/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const reopened = await openJournal(dir);
    await reopened.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
