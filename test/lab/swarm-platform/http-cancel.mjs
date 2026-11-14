import { nativeHttpIntent } from './http-intent.mjs';
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { swarmService } from '../../../cli/src/server/runtime/swarm-service.ts';
import { request, traffic } from './http-probe.mjs';
const run = promisify(execFile); const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const [input, output] = process.argv.slice(2); assert.ok(input && output);
const manifest = JSON.parse(await readFile(input, 'utf8')); assert.equal(manifest.app, 'rollout-http');
await mkdir(output, { mode: 0o700 }); await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const env = { ...process.env, COMPOSE_FILE: 'docker-compose.yml:docker-compose.ci.yml:docker-compose.swarm.yml:registration-lab.yml' };
const compose = async (...args) => (await run('docker', ['compose', ...args], { cwd: '/opt/platform', env, timeout: 20000, maxBuffer: 1024 * 1024 })).stdout.trim();
const ctl = async (...args) => JSON.parse(await compose('exec', '-T', 'deployer', 'kayra-deployer', 'ctl', ...args));
const status = () => ctl('lifecycle', 'status', manifest.app); const native = swarmService(dockerApi()); const target = { host: 'rollout.lab.test', ca: await readFile('/var/lib/kayra/swarm/lab-ca.pem', 'utf8') };
const trace = []; const values = []; let stop; let peakTasks = 0;
const event = (kind, fields = {}) => { const value = { at: Date.now(), kind, ...fields }; trace.push(value); console.log(JSON.stringify(value)); };
const wait = async (condition, label, timeout = 95000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await condition(); if (value) return value; await pause(250); }
  throw Error('timed out: ' + label);
};
try {
  const reset = await ctl('lifecycle', 'prepare', manifest.app, manifest.commits.A, manifest.resetRequest);
  assert.ok(!['succeeded', 'failed', 'cancelled', 'held'].includes(reset.phase));
  reset.nativePlan = nativeHttpIntent(reset, await ctl("preview", manifest.app, manifest.commits.A));
  const initial = await wait(async () => { const value = await status(); if (value.operation === null) { assert.ok(!['failed', 'held', 'cancelled'].includes(value.preparation.phase)); return undefined; } assert.notEqual(value.operation.phase, 'held'); return value.operation.phase === 'succeeded' ? value : undefined; }, 'verified A');
  const scope = { app: manifest.app, service: 'web', incarnation: initial.incarnation }; const before = await native.observe(scope); assert.equal(before.status, 'owned');
  stop = traffic(target, (value) => values.push(value)); await pause(5000);
  const headers = Promise.withResolvers(); const long = request(target, { path: '/slow?ms=20000', timeout: 25000, onHeaders: (value) => headers.resolve(value) });
  const longHeaders = await headers.promise; assert.equal(longHeaders.release, 'A'); event('long-request-started', longHeaders);
  const accepted = await ctl('lifecycle', 'prepare', manifest.app, manifest.commits['slow-ready'], manifest.updateRequest);
  accepted.nativePlan = nativeHttpIntent(accepted, await ctl('preview', manifest.app, manifest.commits['slow-ready']));
  await wait(async () => { const value = await native.observe(scope); return value.status === 'owned' && value.id === before.id && value.version > before.version && value.taskPlan === accepted.nativePlan ? value : undefined; }, 'candidate acknowledgement', 90000);
  const acknowledged = await status(); assert.equal(acknowledged.operation.request, accepted.request); accepted.httpDeadline = acknowledged.operation.updateDeadline;
  assert.ok(accepted.version === 1 ? accepted.httpDeadline === accepted.deadline : accepted.httpDeadline <= accepted.deadline);
  const cancelledAt = Date.now(); const cancelled = await ctl('lifecycle', 'cancel', manifest.app, manifest.updateRequest);
  assert.equal(cancelled.phase, 'recovering'); assert.ok(cancelled.cancelRequestedAt >= cancelledAt); event('cancellation-accepted', { cancelled });
  const restoration = await wait(async () => {
    const value = await native.observe(scope); if (value.status !== 'owned') return undefined;
    peakTasks = Math.max(peakTasks, value.tasks.filter((task) => !['shutdown', 'complete', 'failed', 'rejected', 'remove', 'orphaned'].includes(task.state)).length);
    return value.taskPlan === reset.nativePlan && value.taskEffect === 'restore' ? value : undefined;
  }, 'restoration acknowledgement');
  const deployer = await compose('ps', '-q', 'deployer'); event('observer-killed-after-restore', { native: restoration });
  await run('docker', ['kill', '--signal', 'KILL', deployer]); await pause(3000); await run('docker', ['start', deployer]);
  await wait(async () => { try { return await status(); } catch { return undefined; } }, 'observer restart', 20000);
  const final = await wait(async () => {
    const value = await status(); assert.equal(value.operation.request, manifest.updateRequest); assert.notEqual(value.operation.phase, 'held');
    const runtime = await native.observe(scope); if (runtime.status === 'owned') peakTasks = Math.max(peakTasks, runtime.tasks.filter((task) => !['shutdown', 'complete', 'failed', 'rejected', 'remove', 'orphaned'].includes(task.state)).length);
    return value.operation.phase === 'cancelled' ? { status: value, native: runtime } : undefined;
  }, 'durable cancellation');
  const recoveryMs = Date.now() - cancelledAt; assert.ok(recoveryMs <= 90000);
  assert.equal(final.status.requested.plan, accepted.plan); assert.equal(final.status.desired.plan, reset.plan); assert.equal(final.status.verifiedActive.plan, reset.plan);
  assert.equal(final.status.operation.cancelRequestedAt, cancelled.cancelRequestedAt); assert.equal(final.status.operation.updateDeadline, accepted.httpDeadline);
  assert.equal(final.native.status, 'owned'); assert.equal(final.native.taskEffect, 'restore'); assert.ok(final.native.tasks.some((task) => task.desired === 'running' && task.action.endsWith(':restore:1')));
  const replay = await ctl('lifecycle', 'cancel', manifest.app, manifest.updateRequest); assert.equal(replay.phase, 'cancelled'); assert.equal(replay.cancelRequestedAt, cancelled.cancelRequestedAt);
  await pause(30000); await stop(); stop = undefined;
  const longResult = await long; assert.equal(longResult.status, 200); assert.equal(longResult.release, 'A'); assert.equal(longResult.task, longHeaders.task); assert.equal(longResult.error, undefined);
  const failures = values.filter((value) => value.status !== 200 || value.error !== undefined); assert.equal(failures.length, 0);
  assert.ok(values.every((value) => value.release === 'A' && value.ready)); assert.ok(peakTasks <= 3);
  await writeFile(join(output, 'requests.jsonl'), values.map((value) => JSON.stringify(value)).join('\n') + '\n');
  await writeFile(join(output, 'trace.json'), JSON.stringify(trace, null, 2));
  const result = { passed: true, requests: values.length, failedRequests: failures.length, recoveryMs, long: longResult, peakNonterminalTasks: peakTasks, recoveryCopiesReserved: 3,
    oneAcceptedRestore: true, cancellationSurvivedRestart: true, originalDeadline: accepted.httpDeadline, deploymentDeadline: accepted.deadline, cancellation: cancelled, final, replay };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)); event('cancellation-passed', { result });
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({ at: Date.now(), error: String(error), trace, requests: values }, null, 2));
  console.error(JSON.stringify({ error: String(error), output })); process.exitCode = 1;
} finally { if (stop) await stop(); }
