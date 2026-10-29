import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openJournal } from '../../src/server/deployment/journal.ts';

const temporary = async () => mkdtemp(join(tmpdir(), 'kayra-journal-'));

test('refuses another writer, persists in order, and can be reopened', async () => {
  const dir = await temporary();
  try {
    const journal = await openJournal(dir);
    assert.equal(await journal.read(), undefined);
    await assert.rejects(openJournal(dir), /locked/);
    await Promise.all([journal.write({ phase: 'intent' }), journal.write({ phase: 'complete' })]);
    assert.deepEqual(await journal.read(), { phase: 'complete' });
    await journal.close();
    const reopened = await openJournal(dir);
    assert.deepEqual(await reopened.read(), { phase: 'complete' });
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reports corrupt records rather than treating them as absent', async () => {
  const dir = await temporary();
  try {
    await writeFile(join(dir, 'state.json'), '{broken');
    await assert.rejects(openJournal(dir), SyntaxError);
    assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), '{broken');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an uncertain write poisons the writer until it is reopened', async () => {
  const dir = await temporary();
  try {
    const journal = await openJournal(dir);
    await mkdir(join(dir, 'state.json'));
    await assert.rejects(journal.write({ phase: 'intent' }));
    await assert.rejects(journal.write({ phase: 'complete' }), /reopen and reconcile/);
    await assert.rejects(journal.read(), /reopen and reconcile/);
    await journal.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the OS releases an exclusive writer lock when its process is killed', async () => {
  const dir = await temporary();
  const moduleUrl = new URL('../../src/server/deployment/journal.ts', import.meta.url).href;
  const source = `import { openJournal } from ${JSON.stringify(moduleUrl)};\nconst journal = await openJournal(process.argv[1]);\nawait journal.write({ phase: 'intent', deadline: '2030-01-01T00:00:00Z' });\nconsole.log('ready');\nsetInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', source, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const data: unknown = await Promise.race([
      once(child.stdout, 'data').then((args: readonly unknown[]) => args[0]),
      once(child, 'exit').then(() => { throw new Error('writer exited before acquiring the lock'); }),
    ]);
    assert.equal(String(data).trim(), 'ready');
    await assert.rejects(openJournal(dir), /locked/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const journal = await openJournal(dir);
    assert.deepEqual(await journal.read(), { phase: 'intent', deadline: '2030-01-01T00:00:00Z' });
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')), { phase: 'intent', deadline: '2030-01-01T00:00:00Z' });
    await journal.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('close retains the lock until accepted reads finish', async () => {
  const dir = await temporary();
  try {
    const journal = await openJournal(dir);
    await journal.write({ phase: 'intent' });
    const read = journal.read();
    // eslint-disable-next-line functional/no-let -- observe the read's completion before close
    let finished = false;
    void read.then(() => { finished = true; });
    await journal.close();
    assert.equal(finished, true);
    assert.deepEqual(await read, { phase: 'intent' });
    const reopened = await openJournal(dir);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unreadable or missing previously written record poisons the writer', async () => {
  for (const corrupted of ['{broken', undefined]) {
    const dir = await temporary();
    try {
      const journal = await openJournal(dir);
      await journal.write({ phase: 'intent' });
      if (corrupted === undefined) await rm(join(dir, 'state.json'));
      else await writeFile(join(dir, 'state.json'), corrupted);
      await assert.rejects(journal.read());
      await assert.rejects(journal.write({ phase: 'complete' }), /reopen and reconcile/);
      await journal.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('interrupted initialization and missing state fail closed on reopen', async () => {
  for (const marker of ['kayra-journal-v1\n', 'partial']) {
    const dir = await temporary();
    try {
      await writeFile(join(dir, 'initialized'), marker);
      await assert.rejects(openJournal(dir), /initialization/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('reopening does not mistake deletion of a written state for a new journal', async () => {
  const dir = await temporary();
  try {
    const journal = await openJournal(dir);
    await journal.write({ phase: 'intent' });
    await journal.close();
    assert.equal(await readFile(join(dir, 'initialized'), 'utf8'), 'kayra-journal-v1\n');
    await rm(join(dir, 'state.json'));
    await assert.rejects(openJournal(dir), /intervention required/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
