// Concurrent requests use only the existing coordinator; no runtime effects are injected.
import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { traffic } from './http-probe.mjs';

const [manifestPath, output] = process.argv.slice(2); assert.ok(manifestPath && output);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); assert.equal(manifest.version, 1); assert.equal(manifest.applications.length, 2);
for (const value of manifest.applications) { assert.ok(['admission-left', 'admission-right'].includes(value.app)); assert.match(value.commit, /^[a-f0-9]{40}$/); assert.match(value.request, /^[a-f0-9-]{36}$/); }
assert.notEqual(manifest.applications[0].app, manifest.applications[1].app);
await mkdir(output, { mode: 0o700 }); await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const run = promisify(execFile); const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = { ...process.env, COMPOSE_FILE: 'docker-compose.yml:docker-compose.ci.yml:docker-compose.swarm.yml:registration-lab.yml' };
const docker = async (...args) => (await run('docker', args, { env, cwd: '/opt/platform', timeout: 20000, maxBuffer: 1024 * 1024 })).stdout.trim();
const ctl = async (...args) => JSON.parse(await docker('compose', 'exec', '-T', 'deployer', 'kayra-deployer', 'ctl', ...args));
const requests = []; const events = []; const trace = []; const metrics = []; let phase = 'baseline'; let sampler; let stop; let observer; let observedExit; let complete = false; let evidenceError; let bytes = 0;
const apps = manifest.applications.map((value) => value.app);
const wait = async (condition, label, timeout) => {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (evidenceError) throw new Error(evidenceError); const value = await condition(); if (value) return value; await pause(500); }
  throw new Error('timed out: ' + label);
};
const statuses = () => Promise.all(apps.map((app) => ctl('lifecycle', 'status', app)));
const sample = async () => {
  const values = await statuses(); trace.push({ at: Date.now(), phase, values }); return values;
};
try {
  const existing = await ctl('lifecycle', 'status', 'rollout-complete'); assert.ok(existing.verifiedActive);
  for (const input of manifest.applications) {
    const before = await ctl('lifecycle', 'status', input.app); assert.equal(before.verifiedActive, null);
    const preview = await ctl('preview', input.app, input.commit); assert.equal(preview.plan.workload.services.web.resources.memoryBytes, 1073741824); assert.equal(preview.plan.rollout.migrations.length, 0);
    assert.equal(preview.plan.workload.host.profile.memory_bytes - preview.plan.workload.host.profile.platform_memory_bytes, 2147483648);
  }
  observer = spawn('docker', ['events', '--filter', 'type=container', '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
  observedExit = once(observer, 'exit').catch(() => { evidenceError = 'event observer failed'; }); observer.on('error', () => { evidenceError = 'event observer failed'; }); let partial = '';
  observer.stdout.setEncoding('utf8'); observer.stdout.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk); if (bytes > 8 * 1024 * 1024) { evidenceError = 'event evidence exceeded bound'; observer.kill('SIGTERM'); return; }
    partial += chunk; const lines = partial.split('\n'); partial = lines.pop();
    for (const line of lines) if (line) { try { const value = JSON.parse(line); if (apps.includes(value.Actor?.Attributes?.['com.kayra.app'])) events.push(value); } catch { evidenceError = 'invalid event evidence'; } }
  });
  observer.stderr.on('data', () => { evidenceError = 'event observer reported an error'; }); observedExit.then(() => { if (!complete) evidenceError = 'event observer ended prematurely'; });
  const target = { host: 'complete.lab.test', ca: await readFile('/var/lib/kayra/swarm/lab-ca.pem', 'utf8') };
  sampler = setInterval(async () => {
    try { metrics.push({ at: Date.now(), phase, meminfo: await readFile('/proc/meminfo', 'utf8'), cpu: (await readFile('/proc/stat', 'utf8')).split('\n')[0] }); }
    catch { evidenceError = 'resource observer failed'; }
  }, 1000);
  stop = traffic(target, (value) => requests.push({ ...value, phase })); await pause(30000);
  phase = 'competing'; const receipts = await Promise.all(manifest.applications.map((value) => ctl('lifecycle', 'prepare', value.app, value.commit, value.request)));
  const pending = await sample(); for (let i = 0; i < pending.length; i++) assert.equal((pending[i].operation ?? pending[i].preparation).request, receipts[i].request);
  await wait(async () => {
    const values = await sample(); return events.some((value) => value.Action === 'create') && values.filter((value) => value.preparation?.phase === 'prepared').length === 1;
  }, 'one admitted workload and one capacity waiter', 45000);
  const deployers = (await docker('ps', '-q', '--filter', 'label=com.docker.compose.project=platform', '--filter', 'label=com.docker.compose.service=deployer', '--filter', 'label=com.docker.compose.oneoff=False')).split('\n'); assert.equal(deployers.length, 1);
  phase = 'interruption'; const deployer = deployers[0]; const oldStart = await docker('inspect', deployer, '--format', '{{.State.StartedAt}}');
  await docker('kill', '--signal', 'KILL', deployer); await pause(3000); await docker('start', deployer);
  await wait(async () => { try { return await statuses(); } catch { return undefined; } }, 'coordinator restart', 30000); assert.notEqual(await docker('inspect', deployer, '--format', '{{.State.StartedAt}}'), oldStart);
  phase = 'reconstructed';
  const settled = await wait(async () => {
    const values = await sample(); const phases = values.map((value) => (value.operation ?? value.preparation)?.phase);
    assert.ok(!phases.includes('held')); return phases.includes('failed') && phases.includes('succeeded') ? values : undefined;
  }, 'winner converges and capacity waiter expires at its original deadline', 110000);
  const winner = settled.find((value) => value.operation?.phase === 'succeeded'); const loser = settled.find((value) => value.preparation?.phase === 'failed'); assert.ok(winner && loser);
  assert.equal(winner.verifiedActive.commit, manifest.applications.find((value) => value.app === winner.app).commit); assert.equal(loser.verifiedActive, null); assert.equal(loser.preparation.reason, 'deadline');
  const originalLoser = pending.find((value) => value.app === loser.app); assert.equal(loser.preparation.admissionDeadline, originalLoser.preparation.admissionDeadline); assert.equal(loser.preparation.deadline, originalLoser.preparation.deadline);
  assert.ok(loser.preparation.completedAt >= loser.preparation.admissionDeadline); assert.ok(loser.preparation.completedAt - loser.preparation.admissionDeadline <= 15000);
  const loserObjects = await docker('ps', '-aq', '--filter', 'label=com.kayra.app=' + loser.app); assert.equal(loserObjects, '');
  assert.equal(await docker('service', 'ls', '-q', '--filter', 'name=kayra-' + loser.app + '--web'), '');
  assert.equal(events.filter((value) => value.Actor?.Attributes?.['com.kayra.app'] === loser.app && ['create', 'start'].includes(value.Action)).length, 0);
  const winnerStarts = events.filter((value) => value.Actor?.Attributes?.['com.kayra.app'] === winner.app && value.Action === 'start'); assert.equal(winnerStarts.length, 1);
  const replays = await Promise.all(manifest.applications.map((value) => ctl('lifecycle', 'prepare', value.app, value.commit, value.request)));
  for (let i = 0; i < replays.length; i++) { assert.equal(replays[i].plan, receipts[i].plan); assert.equal(replays[i].deadline, receipts[i].deadline); }
  phase = 'stable'; await pause(30000); await stop(); stop = undefined;
  assert.deepEqual((await ctl('lifecycle', 'status', 'rollout-complete')).verifiedActive, existing.verifiedActive);
  const failures = requests.filter((value) => value.error !== undefined || value.status !== 200); assert.equal(failures.length, 0); assert.ok(requests.every((value) => value.release === 'B'));
  for (const name of ['baseline', 'stable']) assert.ok(requests.filter((value) => value.phase === name).length >= 570);
  const rate = (requests.length - 1) / ((requests.at(-1).at - requests[0].at) / 1000); const maxGapMs = Math.max(...requests.map((value) => value.gapMs ?? 0)); assert.ok(rate >= 19); assert.ok(maxGapMs <= 250); assert.equal(evidenceError, undefined);
  const result = { passed: true, scope: 'serialized declared resource admission, simultaneous real requests and coordinator restart; not host OOM or scheduler reservation guarantees', manifest, receipts, pending, settled, winner: winner.app, loser: loser.app, replays,
    killedWhileAdmissionPending: true, loserWorkloadObjects: 0, winnerStarts: winnerStarts.length, originalAdmissionDeadline: true, requests: requests.length, failedRequests: failures.length, achievedRequestsPerSecond: rate, maxRequestStartGapMs: maxGapMs, versions: JSON.parse(await docker('version', '--format', '{{json .}}')), node: process.version };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), phase, manifest }, null, 2)); process.exitCode = 1; console.error(JSON.stringify({ error: String(error), output }));
} finally {
  if (stop) await stop(); if (sampler) clearInterval(sampler); if (observer && observer.exitCode === null) { complete = true; observer.kill('SIGTERM'); await observedExit; }
  await writeFile(join(output, 'requests.jsonl'), requests.map((value) => JSON.stringify(value)).join('\n') + '\n'); await writeFile(join(output, 'docker-events.json'), JSON.stringify(events, null, 2));
  await writeFile(join(output, 'trace.json'), JSON.stringify(trace, null, 2)); await writeFile(join(output, 'resources.json'), JSON.stringify(metrics, null, 2));
}
