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

test('a legacy committed marker without state and invalid markers fail closed', async () => {
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

test('reads legacy committed journals without rewriting their marker', async () => {
  const dir = await temporary();
  try {
    await writeFile(join(dir, 'initialized'), 'kayra-journal-v1\n');
    await writeFile(join(dir, 'state.json'), '{"phase":"legacy"}');
    const journal = await openJournal(dir);
    assert.deepEqual(await journal.read(), { phase: 'legacy' });
    await journal.write({ phase: 'updated' });
    await journal.close();
    assert.equal(await readFile(join(dir, 'initialized'), 'utf8'), 'kayra-journal-v1\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('completed and recovered initialization remain readable with the legacy marker contract', async () => {
  // The older journal accepts only this marker and a parseable state file.
  const legacyRead = async (dir: string): Promise<unknown> => {
    const marker = await readFile(join(dir, 'initialized'), 'utf8');
    if (marker !== 'kayra-journal-v1\n') throw new Error('journal initialization marker is invalid');
    const state: unknown = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    return state;
  };
  const fresh = await temporary();
  const interrupted = await temporary();
  try {
    const journal = await openJournal(fresh);
    await journal.write({ phase: 'completed' });
    await journal.close();
    assert.deepEqual(await legacyRead(fresh), { phase: 'completed' });

    await writeFile(join(interrupted, 'initialized'), 'kayra-journal-v2:preparing\n');
    await writeFile(join(interrupted, 'state.json'), '{"phase":"preserved"}');
    await assert.rejects(legacyRead(interrupted), /marker is invalid/);
    const recovered = await openJournal(interrupted);
    assert.deepEqual(await recovered.read(), { phase: 'preserved' });
    await recovered.close();
    assert.deepEqual(await legacyRead(interrupted), { phase: 'preserved' });
  } finally {
    await rm(fresh, { recursive: true, force: true });
    await rm(interrupted, { recursive: true, force: true });
  }
});

test('recovers initial writes interrupted at each durable boundary without discarding state', async () => {
  const moduleUrl = new URL('../../src/server/deployment/journal.ts', import.meta.url).href;
  const source = `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const originalOpen = fs.open;
const originalRename = fs.rename;
let renames = 0;
fs.rename = async (...args) => { await originalRename(...args); renames++; };
fs.open = async (...args) => {
  const file = await originalOpen(...args);
  if (args[0] !== process.argv[1] || args[1] !== 'r') return file;
  return { close: () => file.close(), sync: async () => {
    await file.sync();
    if (renames === Number(process.argv[2])) { console.log(renames); await new Promise(() => {}); }
  } };
};
syncBuiltinESMExports();
const { openJournal } = await import(${JSON.stringify(moduleUrl)});
setInterval(() => {}, 1000);
const journal = await openJournal(process.argv[1]);
await journal.write({ phase: 'intent', id: 'original' });
throw new Error('write unexpectedly finished');`;
  for (const phase of [1, 2, 3]) {
    const dir = await temporary();
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', source, dir, String(phase)], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const data: unknown = await Promise.race([
        once(child.stdout, 'data').then((args: readonly unknown[]) => args[0]),
        once(child, 'exit').then(() => { throw new Error(`writer exited before ${String(phase)}`); }),
      ]);
      assert.equal(String(data).trim(), String(phase));
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const journal = await openJournal(dir);
      if (phase === 1) {
        assert.equal(await journal.read(), undefined);
        await journal.write({ phase: 'intent', id: 'retry' });
        assert.deepEqual(await journal.read(), { phase: 'intent', id: 'retry' });
      } else {
        assert.deepEqual(await journal.read(), { phase: 'intent', id: 'original' });
      }
      await journal.close();
      assert.equal(await readFile(join(dir, 'initialized'), 'utf8'), 'kayra-journal-v1\n');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('recovers after an actual state rename failure in first initialization', async () => {
  const dir = await temporary();
  try {
    const journal = await openJournal(dir);
    await mkdir(join(dir, 'state.json'));
    await assert.rejects(journal.write({ phase: 'intent' }));
    await journal.close();
    await rm(join(dir, 'state.json'), { recursive: true });
    const recovered = await openJournal(dir);
    assert.equal(await recovered.read(), undefined);
    await recovered.write({ phase: 'retry' });
    assert.deepEqual(await recovered.read(), { phase: 'retry' });
    await recovered.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reconciles actual first-write I/O failures at each file sync, rename and directory sync', async () => {
  const moduleUrl = new URL('../../src/server/deployment/journal.ts', import.meta.url).href;
  const source = `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const originalOpen = fs.open;
const originalRename = fs.rename;
let temp = 0, renamed = 0;
const fail = (kind, number) => {
  if (kind === process.argv[2] && number === Number(process.argv[3])) throw new Error('injected I/O failure');
};
fs.rename = async (...args) => { fail('rename', temp); await originalRename(...args); renamed = temp; };
fs.open = async (...args) => {
  const file = await originalOpen(...args);
  const isTemp = String(args[0]).includes('.journal-');
  const number = isTemp ? ++temp : 0;
  if (!isTemp && !(args[0] === process.argv[1] && args[1] === 'r')) return file;
  return { writeFile: (...a) => file.writeFile(...a), close: () => file.close(), sync: async () => {
    if (isTemp) fail('file-sync', number);
    else if (renamed) fail('directory-sync', renamed);
    await file.sync();
  } };
};
syncBuiltinESMExports();
const { openJournal } = await import(${JSON.stringify(moduleUrl)});
const journal = await openJournal(process.argv[1]);
try { await journal.write({ phase: 'intent', id: 'original' }); throw new Error('failure was not injected'); }
catch (e) { if (e.message !== 'injected I/O failure') throw e; }
await journal.close();`;
  for (const kind of ['file-sync', 'rename', 'directory-sync']) {
    for (const number of [1, 2, 3]) {
      const dir = await temporary();
      const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', source, dir, kind, String(number)], { stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        const exit: readonly unknown[] = await once(child, 'exit');
        assert.equal(exit[0], 0, `${kind} ${String(number)} child failed`);
        const journal = await openJournal(dir);
        const recovered: unknown = await journal.read();
        const stateWasRenamed = number > 2 || (number === 2 && kind === 'directory-sync');
        if (stateWasRenamed) assert.deepEqual(recovered, { phase: 'intent', id: 'original' });
        else {
          assert.equal(recovered, undefined);
          await journal.write({ phase: 'retry' });
        }
        await journal.close();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
});

test('does not treat a malformed preparing state as a missing state', async () => {
  const dir = await temporary();
  try {
    await writeFile(join(dir, 'initialized'), 'kayra-journal-v2:preparing\n');
    await writeFile(join(dir, 'state.json'), '{broken');
    await assert.rejects(openJournal(dir), SyntaxError);
    assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), '{broken');
    assert.equal(await readFile(join(dir, 'initialized'), 'utf8'), 'kayra-journal-v2:preparing\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
