// Isolated platform allocation recovery, not application admission or full registration publication.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appOverlayAllocation } from '../../../cli/src/server/platform/app-overlay-allocation.ts';
import { appOverlays } from '../../../cli/src/server/runtime/app-overlay.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { openJournal } from '../../../cli/src/server/deployment/journal.ts';

const [mode, output, cut] = process.argv.slice(2); assert.ok(output);
const api = dockerApi();
const native = appOverlays({ request: async (...args) => {
  const reply = await api.request(...args);
  await appendFile(join(output, 'api-requests.jsonl'), JSON.stringify({ at: Date.now(), method: args[0], path: args[1], status: reply.status }) + '\n');
  return reply;
} });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checkpoint = async () => { process.send({ checkpoint: cut }); await new Promise(() => {}); };
if (mode === '--child') {
  setInterval(() => {}, 1000);
  const input = JSON.parse(await readFile(join(output, cut, 'request.json'), 'utf8'));
  const journal = await openJournal(join(output, cut, 'journal'));
  const storage = { read: journal.read, write: async (record) => { await journal.write(record); if (record.grant !== null && cut === 'after-receipt') await checkpoint(); } };
  const port = { observe: native.observe, create: async (action) => {
    if (cut === 'before-create') await checkpoint();
    const reply = await native.create(action);
    if (cut === 'after-create') { assert.equal(reply, 'acknowledged'); await checkpoint(); }
    return reply;
  } };
  await appOverlayAllocation({ storage, native: port, now: Date.now, newId: randomUUID, authorize: () => Promise.resolve(true) }).provision(input.reference, input.scope);
  throw new Error('child missed its checkpoint');
} else {
  assert.equal(mode, '--run'); await mkdir(output, { recursive: true });
  const events = []; let partial = ''; let bytes = 0; let eventError; let finished = false;
  const observer = spawn('docker', ['events', '--filter', 'type=network', '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const observerExit = once(observer, 'exit');
  observer.on('error', () => { eventError = 'event observer failed'; }); observer.stderr.on('data', () => { eventError = 'event observer stderr'; });
  observer.stdout.setEncoding('utf8'); observer.stdout.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk); if (bytes > 1024 * 1024) { eventError = 'event bound exceeded'; observer.kill(); return; }
    partial += chunk; const lines = partial.split('\n'); partial = lines.pop();
    for (const line of lines) if (line) { try { events.push(JSON.parse(line)); } catch { eventError = 'invalid event'; } }
  });
  observerExit.then(() => { if (!finished) eventError = 'event observer ended early'; });
  const info = await api.request('GET', '/info'); assert.equal(info.status, 200);
  const cases = [];
  try {
    await pause(200);
    for (const phase of ['before-create', 'after-create', 'after-receipt']) {
      const directory = join(output, phase); await mkdir(directory); await mkdir(join(directory, 'journal'));
      const incarnation = randomUUID(); const app = 'overlay-state-lab';
      const input = { reference: { version: 1, runtime: 'swarm', registration: { version: 1, app, incarnation, actionId: `${incarnation}:1`, registrationGeneration: randomUUID() }, ownership: { version: 1, app, incarnation, dataOwner: randomUUID() } },
        scope: { version: 1, app, incarnation, node: info.value.Swarm.NodeID, cluster: info.value.Swarm.Cluster.ID, name: `kayra-app-${incarnation}` } };
      await writeFile(join(directory, 'request.json'), JSON.stringify(input));
      const child = fork(fileURLToPath(import.meta.url), ['--child', output, phase], { execPath: process.execPath, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const exited = once(child, 'exit'); let stdout = ''; let stderr = ''; let timer;
      child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill('SIGKILL'); });
      child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill('SIGKILL'); });
      try {
        const [message] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('child exited before checkpoint'); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('checkpoint timed out')), 20000); })]);
        assert.equal(message.checkpoint, phase); await assert.rejects(openJournal(join(directory, 'journal'), 'existing'), /locked|busy/);
        const before = JSON.parse(await readFile(join(directory, 'journal/state.json'), 'utf8'));
        child.kill('SIGKILL'); assert.equal((await exited)[1], 'SIGKILL');
        const journal = await openJournal(join(directory, 'journal'), 'existing');
        try {
          const controller = appOverlayAllocation({ storage: journal, native, now: Date.now, newId: randomUUID, authorize: () => Promise.resolve(true) });
          const restored = await controller.provision(input.reference, input.scope); assert.ok(restored.ok);
          const after = await journal.read(); assert.equal(after.action.deadline, before.action.deadline); assert.equal(after.action.operation, before.action.operation);
          assert.deepEqual(await controller.provision(input.reference, input.scope), restored);
          cases.push({ cut: phase, grant: restored.value, originalDeadline: before.action.deadline, recoveredDeadline: after.action.deadline });
          if (phase === 'after-receipt') {
            assert.equal((await api.request('DELETE', `/networks/${restored.value.id}`)).status, 204);
            assert.equal((await controller.provision(input.reference, input.scope)).ok, false);
          }
        } finally { await journal.close(); }
      } finally {
        clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
        await writeFile(join(directory, 'child.stdout'), stdout); await writeFile(join(directory, 'child.stderr'), stderr);
      }
    }
    await pause(200); assert.equal(eventError, undefined);
    for (const item of cases) { item.nativeCreates = events.filter((event) => event.Action === 'create' && event.Actor?.ID === item.grant.id).length; assert.equal(item.nativeCreates, 1); }
    const result = { passed: true, scope: 'platform allocation and native overlay recovery with fixture lifecycle authorization; no published registration grant or workload admission', cases, missingRecordedGrantRefused: true, node: process.version };
    await writeFile(join(output, 'app-overlay-state.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally {
    finished = true; observer.kill('SIGTERM'); await observerExit;
    await writeFile(join(output, 'network-events.json'), JSON.stringify(events, null, 2));
    await writeFile(join(output, 'network-event-observer.json'), JSON.stringify({ complete: eventError === undefined && partial === '', error: eventError ?? null }));
  }
}
