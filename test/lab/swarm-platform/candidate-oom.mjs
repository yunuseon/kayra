// Existing builder/coordinator own all workload effects; this observer only submits and measures.
import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { nativeHttpIntent } from './http-intent.mjs';
import { prematureCandidateRequests } from './http-observations.mjs';
import { request, traffic } from './http-probe.mjs';

const [app, commit, identity, output] = process.argv.slice(2);
assert.equal(app, 'rollout-complete'); assert.match(commit, /^[a-f0-9]{40}$/); assert.match(identity, /^[a-f0-9-]{36}$/); assert.ok(output);
await mkdir(output, { mode: 0o700 });
const run = promisify(execFile); const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = { ...process.env, COMPOSE_FILE: 'docker-compose.yml:docker-compose.ci.yml:docker-compose.swarm.yml:registration-lab.yml' };
const docker = async (...args) => (await run('docker', args, { env, cwd: '/opt/platform', timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
const ctl = async (...args) => JSON.parse(await docker('compose', 'exec', '-T', 'deployer', 'kayra-deployer', 'ctl', ...args));
const status = () => ctl('lifecycle', 'status', app);
const events = []; const trace = []; const requests = []; const metrics = []; let phase = 'building'; let stop; let sampler; let observer; let observedExit; let evidenceError; let observerComplete = false; let bytes = 0;
const wait = async (condition, label, milliseconds) => {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) { if (evidenceError) throw new Error(evidenceError); const value = await condition(); if (value) return value; await pause(500); }
  throw new Error('timed out: ' + label);
};
try {
  const before = await status(); assert.ok(before.verifiedActive); const previous = before.verifiedActive;
  const build = await ctl('build', app, commit); const preview = await ctl('preview', app, commit);
  assert.equal(preview.plan.rollout.migrations.length, 0); assert.equal(preview.plan.workload.services.web.resources.memoryBytes, 134217728);
  assert.equal(preview.plan.workload.services.web.environment.OOM_BYTES.value, '536870912');
  const target = { host: 'complete.lab.test', ca: await readFile('/var/lib/kayra/swarm/lab-ca.pem', 'utf8') };
  assert.equal((await request(target)).release, 'B');
  observer = spawn('docker', ['events', '--filter', 'label=com.kayra.app=' + app, '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
  observedExit = once(observer, 'exit').catch(() => { evidenceError = 'event observer failed'; }); observer.on('error', () => { evidenceError = 'event observer failed'; }); let partial = '';
  observer.stdout.setEncoding('utf8'); observer.stdout.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk); if (bytes > 8 * 1024 * 1024) { evidenceError = 'event evidence exceeded bound'; observer.kill('SIGTERM'); return; }
    partial += chunk; const lines = partial.split('\n'); partial = lines.pop();
    for (const line of lines) if (line) { try { events.push(JSON.parse(line)); } catch { evidenceError = 'invalid event evidence'; } }
  });
  observer.stderr.on('data', () => { evidenceError = 'event observer reported an error'; }); observedExit.then(() => { if (!observerComplete) evidenceError = 'event observer ended prematurely'; });
  let previousCpu;
  sampler = setInterval(async () => {
    try {
      const memory = Object.fromEntries((await readFile('/proc/meminfo', 'utf8')).split('\n').flatMap((line) => { const match = /^(MemTotal|MemAvailable):\s+(\d+) kB$/.exec(line); return match ? [[match[1], Number(match[2]) * 1024]] : []; }));
      const cpu = (await readFile('/proc/stat', 'utf8')).split('\n')[0].trim().split(/\s+/).slice(1).map(Number); const total = cpu.reduce((sum, value) => sum + value, 0); const idle = cpu[3] + cpu[4];
      const cpuBusyFraction = previousCpu === undefined ? null : 1 - (idle - previousCpu.idle) / Math.max(1, total - previousCpu.total); previousCpu = { total, idle };
      metrics.push({ at: Date.now(), phase, memory, cpuBusyFraction });
    } catch { evidenceError = 'resource observer failed'; }
  }, 1000);
  phase = 'baseline'; stop = traffic(target, (value) => requests.push({ ...value, phase })); await pause(30000);
  phase = 'candidate'; const receipt = await ctl('lifecycle', 'prepare', app, commit, identity); const candidatePlan = nativeHttpIntent(receipt, preview);
  assert.equal(receipt.version, 2); assert.notEqual(receipt.plan, previous.plan);
  const oom = await wait(() => events.find((value) => value.Action === 'oom' && value.Actor?.Attributes?.['com.kayra.plan'] === candidatePlan), 'candidate cgroup OOM', 90000);
  phase = 'recovery'; const oomAt = oom.timeNano / 1e6;
  const recovered = await wait(async () => {
    const value = await status(); trace.push({ at: Date.now(), value });
    const current = value.operation ?? value.preparation; assert.equal(current.request, identity); assert.notEqual(current.phase, 'succeeded'); assert.notEqual(current.phase, 'held');
    return current.phase === 'failed' ? value : undefined;
  }, 'certified previous release after OOM', Math.max(1, 90000 - (Date.now() - oomAt)));
  const restoredAt = Date.now(); assert.equal(recovered.verifiedActive.plan, previous.plan); assert.equal(recovered.lastKnownGood.plan, previous.plan);
  assert.equal(recovered.desired.plan, previous.plan); assert.equal(recovered.requested.plan, receipt.plan); assert.equal(recovered.operation.recovery, 'automatic-rollback');
  assert.ok(restoredAt - oomAt <= 90000);
  const state = JSON.parse(await docker('inspect', oom.Actor.ID, '--format', '{{json .State}}')); assert.equal(state.OOMKilled, true);
  const taskState = await docker('service', 'ps', '--no-trunc', '--format', '{{json .}}', 'kayra-' + app + '--web');
  const update = JSON.parse(await docker('service', 'inspect', 'kayra-' + app + '--web', '--format', '{{json .UpdateStatus}}')); assert.equal(update.State, 'rollback_completed');
  const replay = await ctl('lifecycle', 'prepare', app, commit, identity); assert.equal(replay.plan, receipt.plan); assert.equal(replay.deadline, receipt.deadline); assert.equal(replay.phase, 'failed');
  phase = 'stable'; await pause(30000); await stop(); stop = undefined;
  const failures = requests.filter((value) => value.error !== undefined || value.status !== 200); const premature = prematureCandidateRequests(requests, 'OOM'); assert.equal(premature.length, 0);
  for (const name of ['baseline', 'stable']) { const values = requests.filter((value) => value.phase === name); assert.ok(values.length >= 570); assert.ok(values.every((value) => value.status === 200 && value.error === undefined && value.release === 'B')); }
  assert.ok(requests.some((value) => value.release === 'OOM')); assert.ok(requests.some((value) => value.connection === 'fresh') && requests.some((value) => value.connection === 'persistent'));
  const rate = (requests.length - 1) / ((requests.at(-1).at - requests[0].at) / 1000); const maxGapMs = Math.max(...requests.map((value) => value.gapMs ?? 0)); assert.ok(rate >= 19); assert.ok(maxGapMs <= 250);
  assert.ok(metrics.length >= 60); const minimumAvailableMemoryBytes = Math.min(...metrics.map((value) => value.memory.MemAvailable)); assert.ok(minimumAvailableMemoryBytes >= 536870912, 'host memory pressure exceeded the bounded container experiment');
  const firstFailureAt = failures.length === 0 ? null : Math.min(...failures.map((value) => value.at)); const lastFailureEndedAt = failures.length === 0 ? null : Math.max(...failures.map((value) => value.endedAt));
  const nextSuccess = failures.length === 0 ? undefined : requests.find((value) => value.at > Math.max(...failures.map((failure) => failure.at)) && value.status === 200 && value.error === undefined);
  const logs = await docker('service', 'logs', '--raw', '--timestamps', 'kayra-' + app + '--web'); await writeFile(join(output, 'application.log'), logs);
  assert.equal(evidenceError, undefined);
  const result = { passed: true, scope: 'real builder/coordinator, container cgroup OOM and native rollback; disruption is measured, not uninterrupted rollback or global OOM acceptance', app, commit, identity, build, receipt, candidatePlan, before, recovered, replay,
    oom: { at: oomAt, container: oom.Actor.ID, state }, nativeUpdate: update, taskState, restoredAt, recoveryMs: restoredAt - oomAt,
    requests: requests.length, failedRequests: failures.length, prematureExposure: premature.length, firstFailureAt, lastFailureEndedAt, failureWindowMs: failures.length === 0 ? 0 : lastFailureEndedAt - firstFailureAt, nextSuccessAt: nextSuccess?.at ?? null,
    achievedRequestsPerSecond: rate, maxRequestStartGapMs: maxGapMs, minimumAvailableMemoryBytes, peakCpuBusyFraction: Math.max(...metrics.map((value) => value.cpuBusyFraction ?? 0)), versions: JSON.parse(await docker('version', '--format', '{{json .}}')), node: process.version };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), phase, app, commit, identity }, null, 2)); process.exitCode = 1; console.error(JSON.stringify({ error: String(error), output }));
} finally {
  if (stop) await stop(); if (sampler) clearInterval(sampler); if (observer && observer.exitCode === null) { observerComplete = true; observer.kill('SIGTERM'); await observedExit; }
  await writeFile(join(output, 'requests.jsonl'), requests.map((value) => JSON.stringify(value)).join('\n') + '\n');
  await writeFile(join(output, 'docker-events.json'), JSON.stringify(events, null, 2)); await writeFile(join(output, 'trace.json'), JSON.stringify(trace, null, 2)); await writeFile(join(output, 'resources.json'), JSON.stringify(metrics, null, 2));
}
