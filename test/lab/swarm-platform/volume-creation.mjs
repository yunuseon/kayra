// Isolated private creation journals and native volumes; admission is a fixture port, not the indexed deployer.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ownedVolume } from '../../../cli/src/contracts/owned-volume.ts';
import { dataVolumeCreation, parseDataVolumeCreation } from '../../../cli/src/server/deployment/data-volume-creation.ts';
import { openJournal } from '../../../cli/src/server/deployment/journal.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { ownedVolumes } from '../../../cli/src/server/runtime/owned-volume.ts';

const [mode, output, cut] = process.argv.slice(2); assert.ok(output); const api = dockerApi();
const native = ownedVolumes({ request: async (...args) => {
  const reply = await api.request(...args); await appendFile(join(output, 'api-requests.jsonl'), JSON.stringify({ at: Date.now(), method: args[0], path: args[1], status: reply.status }) + '\n'); return reply;
} });
const forever = () => new Promise(() => {});
if (mode === '--child') {
  assert.ok(['before-create', 'after-create', 'after-receipt'].includes(cut));
  const request = JSON.parse(await readFile(join(output, cut, 'request.json'), 'utf8')); const journal = await openJournal(join(output, cut, 'journal'));
  const checkpoint = (phase) => { process.stdout.write(JSON.stringify({ checkpoint: phase, pid: process.pid, at: Date.now() }) + '\n'); };
  const wrapped = { read: journal.read, write: async (value) => { await journal.write(value); if (cut === 'after-receipt' && parseDataVolumeCreation(value).phase === 'ready') { checkpoint(cut); await forever(); } } };
  const runtime = { observe: native.observe, create: async (action) => {
    assert.equal(parseDataVolumeCreation(await journal.read()).phase, 'creating');
    if (cut === 'before-create') { checkpoint(cut); await forever(); }
    const reply = await native.create(action); assert.equal(reply, 'acknowledged');
    if (cut === 'after-create') { checkpoint(cut); await forever(); }
    return reply;
  } };
  const engine = dataVolumeCreation(wrapped, { native: runtime, authorize: () => Promise.resolve(true), now: Date.now });
  await engine.prepare(request); await engine.tick(); await engine.tick(); throw new Error('expected kill checkpoint was not reached');
} else {
  assert.equal(mode, '--run'); await mkdir(output, { mode: 0o700 });
  const events = []; let eventError; let eventBytes = 0; let complete = false; let partial = '';
  const observer = spawn('docker', ['events', '--filter', 'type=volume', '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'] }); const observedExit = once(observer, 'exit');
  observer.on('error', () => { eventError = 'volume event observer failed'; }); observer.stderr.on('data', () => { eventError = 'volume event observer error'; });
  observer.stdout.setEncoding('utf8'); observer.stdout.on('data', (chunk) => { eventBytes += Buffer.byteLength(chunk); if (eventBytes > 1024 * 1024) { eventError = 'volume event bound exceeded'; observer.kill('SIGTERM'); return; } partial += chunk; const lines = partial.split('\n'); partial = lines.pop(); for (const line of lines) if (line) { try { events.push(JSON.parse(line)); } catch { eventError = 'invalid volume event'; } } });
  observedExit.then(() => { if (!complete) eventError = 'volume observer ended early'; });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const request = async (name, expired = false) => {
    const owner = { version: 1, app: 'volume-state-lab', incarnation: randomUUID(), dataOwner: randomUUID() }; const volume = ownedVolume(owner.app, owner.dataOwner, randomUUID(), 'data'); assert.ok(volume.ok);
    const createdAt = Date.now() - (expired ? 91000 : 0); const value = { owner, deployment: 'a'.repeat(64), action: { volume: volume.value, operation: randomUUID(), deadline: createdAt + 90000 }, createdAt };
    const path = join(output, name); await mkdir(path, { mode: 0o700 }); await mkdir(join(path, 'journal'), { mode: 0o700 }); await writeFile(join(path, 'request.json'), JSON.stringify(value)); return value;
  };
  const settle = async (name, expected) => {
    const journal = await openJournal(join(output, name, 'journal'), 'existing');
    try {
      const engine = dataVolumeCreation(journal, { native, authorize: () => Promise.resolve(true), now: Date.now });
      for (let i = 0; i < 10; i++) { const result = await engine.tick(); if (result.state.phase === 'ready') { assert.equal(result.observation, 'owned'); assert.equal(result.state.action.deadline, expected.action.deadline); assert.deepEqual(result.state.action.volume, expected.action.volume); return result.state; } assert.notEqual(result.state.phase, 'held'); }
      throw new Error('volume did not settle');
    } finally { await journal.close(); }
  };
  const cases = [];
  try {
    await pause(200);
    for (const phase of ['before-create', 'after-create', 'after-receipt']) {
      const input = await request(phase); const reached = Promise.withResolvers(); let stdout = ''; let stderr = ''; let childPartial = '';
      const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--child', output, phase], { stdio: ['ignore', 'pipe', 'pipe'] }); const exited = once(child, 'exit');
      child.on('error', reached.reject); exited.then(() => { reached.reject(new Error('child exited before its checkpoint')); });
      child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => {
        stdout += chunk; if (Buffer.byteLength(stdout) > 1024 * 1024) { reached.reject(new Error('child output bound')); return; }
        childPartial += chunk; const lines = childPartial.split('\n'); childPartial = lines.pop();
        for (const line of lines) if (line) { try { const message = JSON.parse(line); assert.equal(message.checkpoint, phase); reached.resolve(message); } catch (error) { reached.reject(error); } }
      });
      child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { stderr += chunk; if (Buffer.byteLength(stderr) > 1024 * 1024) reached.reject(new Error('child stderr bound')); });
      let timer;
      try {
        const checkpoint = await Promise.race([reached.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('native kill checkpoint deadline')), 20000); })]);
        await assert.rejects(openJournal(join(output, phase, 'journal'), 'existing'), /locked|busy/);
        const before = parseDataVolumeCreation(JSON.parse(await readFile(join(output, phase, 'journal/state.json'), 'utf8'))); assert.equal(before.action.deadline, input.action.deadline);
        child.kill('SIGKILL'); const [, signal] = await exited; assert.equal(signal, 'SIGKILL');
        const restored = await settle(phase, input); cases.push({ cut: phase, checkpoint, originalDeadline: input.action.deadline, restoredDeadline: restored.action.deadline, phase: restored.phase, attempts: restored.attempts, volume: input.action.volume.name });
      } finally {
        clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
        await writeFile(join(output, phase, 'child.stdout'), stdout); await writeFile(join(output, phase, 'child.stderr'), stderr);
      }
    }
    const missing = await request('missing'); const journal = await openJournal(join(output, 'missing/journal'));
    try {
      const engine = dataVolumeCreation(journal, { native, authorize: () => Promise.resolve(true), now: Date.now }); await engine.prepare(missing); await engine.tick(); const ready = await engine.tick(); assert.equal(ready.state.phase, 'ready');
      assert.equal(await native.remove(missing.action, { volume: missing.action.volume, createdAt: ready.state.receipt }), 'acknowledged');
      const held = await engine.tick(); assert.equal(held.state.reason, 'missing'); await engine.tick(); assert.equal((await native.observe(missing.action.volume)).status, 'absent');
    } finally { await journal.close(); }
    const expired = await request('expired', true); const expiredJournal = await openJournal(join(output, 'expired/journal'));
    try { const engine = dataVolumeCreation(expiredJournal, { native, authorize: () => Promise.resolve(true), now: Date.now }); await engine.prepare(expired); assert.equal((await engine.tick()).state.reason, 'deadline'); assert.equal((await native.observe(expired.action.volume)).status, 'absent'); } finally { await expiredJournal.close(); }
    await pause(200); assert.equal(eventError, undefined);
    for (const item of cases) { item.nativeCreates = events.filter((event) => event.Action === 'create' && event.Actor?.ID === item.volume).length; assert.equal(item.nativeCreates, 1); }
    assert.equal(events.filter((event) => event.Action === 'create' && event.Actor?.ID === missing.action.volume.name).length, 1);
    assert.equal(events.filter((event) => event.Action === 'create' && event.Actor?.ID === expired.action.volume.name).length, 0);
    const result = { passed: true, scope: 'isolated creation coordinator with native volumes and synchronized OS-locked journals; fixture authorization, not indexed admission or app data-retention acceptance', cases, missingVolumeHeldWithoutRecreation: true, expiredIntentCreatedNothing: true, node: process.version };
    await writeFile(join(output, 'volume-state.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } catch (error) { await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), cases }, null, 2)); throw error; }
  finally { complete = true; if (observer.exitCode === null) { observer.kill('SIGTERM'); await observedExit; } await writeFile(join(output, 'docker-events.json'), JSON.stringify(events, null, 2)); }
}
