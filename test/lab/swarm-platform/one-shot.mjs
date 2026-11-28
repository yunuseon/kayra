import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { jobName, jobPlanDigest } from '../../../cli/src/contracts/one-shot-job.ts';
import { oneShotExecution } from '../../../cli/src/server/deployment/one-shot-execution.ts';
import { openJournal } from '../../../cli/src/server/deployment/journal.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { oneShotJob } from '../../../cli/src/server/runtime/one-shot-job.ts';

const run = promisify(execFile); const api = dockerApi(); const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const [mode, directory, image] = process.argv.slice(2);
assert.ok(directory); const child = mode.startsWith('child:'); const native = oneShotJob(api);
const kill = () => { process.kill(process.pid, 'SIGKILL'); };
const ports = (plan, checkpoint = '') => ({ now: Date.now, read: async (digest) => { assert.equal(digest, jobPlanDigest(plan)); return plan; },
  authorize: async (_record, effect) => { if (effect === 'start' && checkpoint === 'before-start') kill(); return true; },
  materialize: async () => ({}), native: { ...native,
    create: async (...args) => { const result = await native.create(...args); if (checkpoint === 'after-create') kill(); return result; },
    start: async (...args) => { const result = await native.start(...args); if (checkpoint === 'after-start') kill(); return result; },
    fence: async (...args) => { const result = await native.fence(...args); if (checkpoint === 'after-fence') kill(); return result; },
  },
});
if (child) {
  const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8'));
  const journal = await openJournal(directory, 'existing'); const owner = oneShotExecution(journal, ports(plan, mode.slice(6)));
  while (true) { const result = await owner.tick(); assert.ok(result.phase !== 'held' && result.phase !== 'complete', 'child missed its checkpoint'); await pause(100); }
}
assert.equal(mode, 'run'); assert.match(image, /^localhost:5000\/[a-z][a-z0-9-]{0,47}\/web@sha256:[0-9a-f]{64}$/);
const app = image.split('/')[1];
await mkdir(directory, { mode: 0o700 }); const reports = [];
for (const checkpoint of ['after-create', 'before-start', 'after-start', 'after-fence']) {
  const path = join(directory, checkpoint); await mkdir(path, { mode: 0o700 });
  const startedAt = Date.now(); const plan = { version: 1,
    scope: { app, incarnation: randomUUID(), run: randomUUID(), step: 'schema-probe', purpose: 'migration', attempt: 1 },
    image, command: ['sh', '-c', "printf 'one-shot lab effect\\n'"], entrypoint: null, environment: {},
    resources: { memoryBytes: 64 * 1024 * 1024, nanoCpus: 100_000_000 }, networks: [], deadline: startedAt + 60000, stopGraceSeconds: 30,
  };
  await writeFile(join(path, 'plan.json'), JSON.stringify(plan));
  const initial = await openJournal(path); await oneShotExecution(initial, ports(plan)).prepare(plan); await initial.close();
  const killed = await new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [fileURLToPath(import.meta.url), 'child:' + checkpoint, path], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; process.stderr.on('data', (chunk) => chunks.push(chunk)); process.on('error', reject);
    process.on('close', (code, signal) => resolve({ code, signal, stderr: Buffer.concat(chunks).toString() }));
  });
  assert.equal(killed.signal, 'SIGKILL', JSON.stringify(killed));
  const journal = await openJournal(path, 'existing'); let replayedStarts = 0;
  const resumed = ports(plan); const owner = oneShotExecution(journal, { ...resumed, native: { ...resumed.native,
    start: async (...args) => { replayedStarts++; return resumed.native.start(...args); },
  } });
  const recorded = await owner.read(); const trace = [];
  const until = Date.now() + 65000; let final;
  while (Date.now() < until) {
    const value = await owner.tick(); trace.push({ at: Date.now(), value }); assert.notEqual(value.phase, 'held');
    if (value.phase === 'complete') { final = value; break; } await pause(100);
  }
  assert.ok(final, 'job did not converge'); assert.equal(final.deadline, plan.deadline);
  assert.equal(final.evidence.kind, checkpoint === 'before-start' ? 'unknown' : 'succeeded');
  assert.equal(replayedStarts, checkpoint === 'after-create' ? 1 : 0);
  const barrier = await native.observe(plan); assert.equal(barrier.status, 'owned'); assert.equal(barrier.barrier, true); assert.equal(barrier.state, 'created');
  assert.equal(await native.start(plan, barrier.id), 'conflict');
  if (final.container !== null) assert.equal((await api.request('POST', `/containers/${final.container}/start`)).status, 404);
  assert.equal(await native.create(plan, {}), 'conflict');
  const events = (await run('docker', ['events', '--since', String(Math.floor(startedAt / 1000)), '--until', String(Math.floor(Date.now() / 1000) + 1),
    '--filter', 'container=' + final.container, '--format', '{{json .}}'], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout;
  await writeFile(join(path, 'events.jsonl'), events); const starts = events.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.Action === 'start');
  assert.equal(starts.length, checkpoint === 'before-start' ? 0 : 1);
  await writeFile(join(path, 'trace.json'), JSON.stringify(trace, null, 2));
  await journal.close();
  // All dispatches in this disposable probe have settled. Production barriers stay retained.
  assert.equal((await api.request('DELETE', `/containers/${barrier.id}?force=true`)).status, 204);
  reports.push({ checkpoint, killed, originalDeadline: true, evidence: final.evidence, recordedPhase: recorded.phase, replayedStarts, nativeStarts: starts.length, barrierRemoved: true });
  console.log(JSON.stringify(reports.at(-1)));
}
const version = await api.request('GET', '/version'); assert.equal(version.status, 200);
await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, reports, image, node: process.version, engine: version.value.Version, api: version.value.ApiVersion,
  scope: 'isolated one-shot primitive; no migration admission or rollout integration' }, null, 2));
