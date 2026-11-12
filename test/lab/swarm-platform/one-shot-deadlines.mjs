import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { jobName, jobPlanDigest } from '../../../cli/src/contracts/one-shot-job.ts';
import { oneShotExecution } from '../../../cli/src/server/deployment/one-shot-execution.ts';
import { openJournal } from '../../../cli/src/server/deployment/journal.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { oneShotJob } from '../../../cli/src/server/runtime/one-shot-job.ts';

const [mode, directory, image] = process.argv.slice(2); assert.ok(directory);
const api = dockerApi(); const native = oneShotJob(api); const run = promisify(execFile); const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ports = (plan) => ({ native, now: Date.now, read: async (digest) => { assert.equal(digest, jobPlanDigest(plan)); return plan; }, authorize: async () => true, materialize: async () => ({}) });
if (mode === 'child') {
  const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8')); const journal = await openJournal(directory, 'existing');
  const owner = oneShotExecution(journal, { ...ports(plan), native: { ...native, start: async (...args) => {
    const result = await native.start(...args); assert.equal(result, 'acknowledged'); process.kill(process.pid, 'SIGKILL'); return result;
  } } });
  while (true) { const value = await owner.tick(); assert.ok(!['held', 'complete'].includes(value.phase)); await pause(100); }
}
assert.equal(mode, 'run'); assert.match(image, /^localhost:5000\/[a-z][a-z0-9-]{0,47}\/web@sha256:[0-9a-f]{64}$/);
await mkdir(directory, { mode: 0o700 }); const app = image.split('/')[1]; const reports = [];
const cases = [
  { name: 'schedule-expired', timeout: 2, command: ['sh', '-c', 'exit 0'], wait: 1200, expiry: 'scheduling', kind: 'not-started', starts: 0 },
  { name: 'delayed-start', timeout: 1, command: ['sh', '-c', 'exit 0'], wait: 1500, expiry: null, kind: 'succeeded', starts: 1 },
  { name: 'running-after-kill', timeout: 1, command: ['sh', '-c', 'sleep 20'], wait: 1500, expiry: 'execution', kind: 'unknown', starts: 1, kill: true },
  { name: 'late-success', timeout: 1, command: ['sh', '-c', 'sleep 2'], wait: 2500, expiry: 'execution', kind: 'succeeded', starts: 1, kill: true },
  { name: 'timely-success', timeout: 3, command: ['sh', '-c', 'sleep 1'], wait: 3500, expiry: null, kind: 'succeeded', starts: 1, kill: true },
];
for (const item of cases) {
  const path = join(directory, item.name); await mkdir(path, { mode: 0o700 }); const startedAt = Date.now();
  const plan = { version: 1, scope: { app, incarnation: randomUUID(), run: randomUUID(), step: 'deadline', purpose: 'migration', attempt: 1 }, image,
    command: item.command, entrypoint: null, environment: {}, resources: { memoryBytes: 64 * 1024 * 1024, nanoCpus: 100_000_000 }, networks: [],
    deadline: startedAt + 60000, startDeadline: startedAt + (item.name === 'schedule-expired' ? 1000 : 10000), executionTimeoutSeconds: item.timeout, stopGraceSeconds: 30,
  };
  await writeFile(join(path, 'plan.json'), JSON.stringify(plan)); let journal = await openJournal(path); let owner = oneShotExecution(journal, ports(plan));
  await owner.prepare(plan); let originalExecutionDeadline;
  if (item.kill) {
    await journal.close(); const killed = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', path], { stdio: ['ignore', 'ignore', 'pipe'] });
      const errors = []; child.stderr.on('data', (chunk) => errors.push(chunk)); child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, stderr: Buffer.concat(errors).toString() }));
    }); assert.equal(killed.signal, 'SIGKILL', JSON.stringify(killed));
    originalExecutionDeadline = JSON.parse(await readFile(join(path, 'state.json'), 'utf8')).executionDeadline;
    assert.ok(originalExecutionDeadline > 0); await pause(item.wait); journal = await openJournal(path, 'existing'); owner = oneShotExecution(journal, ports(plan));
  } else {
    if (item.name === 'delayed-start') await owner.tick(); await pause(item.wait);
  }
  const trace = []; let final;
  while (Date.now() < plan.deadline + 30000) {
    const value = await owner.tick(); trace.push({ at: Date.now(), value }); assert.notEqual(value.phase, 'held');
    if (value.phase === 'complete') { final = value; break; } await pause(100);
  }
  assert.ok(final); assert.equal(final.expiry, item.expiry); assert.equal(final.evidence.kind, item.kind); assert.equal(final.deadline, plan.deadline);
  if (item.kill) assert.equal(final.executionDeadline, originalExecutionDeadline);
  if (item.name === 'delayed-start') assert.ok(final.executionDeadline >= startedAt + item.wait + item.timeout * 1000);
  if (item.name === 'late-success') assert.ok(final.evidence.finishedAt > final.executionDeadline);
  if (item.name === 'timely-success') assert.ok(final.evidence.finishedAt <= final.executionDeadline);
  const events = (await run('docker', ['events', '--since', String(Math.floor(startedAt / 1000)), '--until', String(Math.floor(Date.now() / 1000) + 1),
    '--filter', 'label=com.kayra.job=' + jobName(plan.scope), '--format', '{{json .}}'], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout;
  await writeFile(join(path, 'events.jsonl'), events); await writeFile(join(path, 'trace.json'), JSON.stringify(trace));
  const starts = events.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.Action === 'start'); assert.equal(starts.length, item.starts);
  const barrier = await native.observe(plan); assert.equal(barrier.status, 'owned'); assert.equal(barrier.barrier, true); await journal.close();
  assert.equal((await api.request('DELETE', `/containers/${barrier.id}?force=true&v=true`)).status, 204);
  reports.push({ name: item.name, expiry: final.expiry, evidence: final.evidence, executionDeadline: final.executionDeadline, originalExecutionDeadline, nativeStarts: starts.length, barrierRemoved: true });
  console.log(JSON.stringify(reports.at(-1)));
}
const version = await api.request('GET', '/version'); await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, reports, image,
  engine: version.value.Version, api: version.value.ApiVersion, node: process.version,
  scope: 'persisted scheduling/execution deadlines; Docker jobs can continue while the coordinator is absent; no native hard-timeout claim' }, null, 2));
