// Real builder artifacts and the existing privileged coordinator; no workload Create/Start from this observer.
import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { jobName } from '../../../cli/src/contracts/one-shot-job.ts';
import { runCompleteHttpCases } from './complete-http-cases.mjs';
import { nativeHttpIntent } from './http-intent.mjs';
import { request, traffic } from './http-probe.mjs';
import { prematureCandidateRequests } from './http-observations.mjs';

const [manifestPath, output] = process.argv.slice(2); assert.ok(manifestPath && output);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); assert.equal(manifest.version, 1);
const managed = manifest.managed === true;
assert.equal(manifest.app, managed ? 'managed-complete' : 'rollout-complete');
await mkdir(output, { mode: 0o700 }); await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const run = promisify(execFile); const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = { ...process.env, COMPOSE_FILE: 'docker-compose.yml:docker-compose.ci.yml:docker-compose.swarm.yml:registration-lab.yml' };
const docker = async (...args) => (await run('docker', args, { cwd: '/opt/platform', env, timeout: 20000, maxBuffer: 1024 * 1024 })).stdout.trim();
const ctl = async (...args) => JSON.parse(await docker('compose', 'exec', '-T', 'deployer', 'kayra-deployer', 'ctl', ...args));
const status = () => ctl('lifecycle', 'status', manifest.app);
const readNativePlan = async () => {
  const services = (await docker('service', 'ls', '-q', '--filter', 'label=com.kayra.app=' + manifest.app)).split('\n');
  assert.equal(services.length, 1);
  const [service] = JSON.parse(await docker('service', 'inspect', services[0]));
  const plan = service.Spec.TaskTemplate.ContainerSpec.Labels['com.kayra.plan'];
  assert.match(plan, /^[a-f0-9]{64}$/);
  return plan;
};
const ledger = async () => JSON.parse(await docker('exec', manifest.ledger, 'node', '--input-type=module', '--eval', 'console.log(await (await fetch("http://127.0.0.1:8080/snapshot")).text())'));
const trace = []; const requests = []; const events = []; const metrics = []; let phase = 'initial'; let stop; let sampler; let stream; let streamExit; let eventError; let bytes = 0;
const event = (kind, value) => { const entry = { at: Date.now(), phase, kind, value }; trace.push(entry); console.log(JSON.stringify(entry)); };
const wait = async (condition, label, timeout = 180000) => {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (eventError) throw new Error(eventError); const value = await condition(); if (value) return value; await pause(250); }
  throw new Error('timed out: ' + label);
};
const currentOperation = (value) => managed ? value?.operation : value?.operation ?? value?.preparation;
const terminal = (receipt, outcomes = ['deployed'], observe = () => {}) => wait(async () => {
  const value = await status(); const current = currentOperation(value);
  if (current == null || (managed ? current.run : current.request) !== receipt.request) return undefined;
  event('status', value);
  observe(current);
  // The managed coordinator records a failed effect before opening automatic compensation on its next tick.
  const recovering = managed && outcomes.includes('rolled-back');
  assert.ok(!['failed', 'cancelled'].includes(current.phase) && (current.phase !== 'held' || recovering), 'fixture rollout did not converge');
  if (!managed) return current.phase === 'succeeded' ? value : undefined;
  if (current.phase !== 'complete') return undefined;
  assert.ok(outcomes.includes(current.outcome), 'unexpected terminal outcome: ' + current.outcome);
  assert.equal(current.settled, true);
  return value;
}, 'verified release ' + receipt.request);
const submit = async (release) => {
  const receipt = await ctl('lifecycle', 'prepare', manifest.app, manifest.commits[release], manifest.requests[release]); assert.equal(receipt.version, managed ? 3 : 2);
  assert.equal(receipt.request, manifest.requests[release]); assert.equal(receipt.commit, manifest.commits[release]); assert.ok(!['succeeded', 'failed', 'cancelled', 'held'].includes(receipt.phase));
  if (managed) { assert.equal(receipt.phase, 'accepted'); return { receipt }; }
  const preview = await ctl('preview', manifest.app, manifest.commits[release]); const nativePlan = nativeHttpIntent(receipt, preview);
  assert.equal(preview.plan.policy.migrationTimeoutCeilingSeconds, manifest.migrationCeilingSeconds); return { receipt, nativePlan, preview: preview.plan };
};
const resumeHttp = async (after) => {
  assert.ok(managed && ['B', 'C', 'D', 'E', 'F'].includes(after));
  const previous = ['D', 'E'].includes(after) ? 'C' : after;
  const start = await status();
  assert.equal(start.operation.phase, 'complete');
  assert.equal(start.verifiedActive.commit, manifest.commits[previous]);
  const target = { host: manifest.host, ca: await readFile('/var/lib/kayra/swarm/lab-ca.pem', 'utf8') };
  const response = await request(target);
  assert.equal(response.status, 200); assert.equal(response.release, previous); assert.equal(response.ready, true);
  event('resumed-http-observation', { after, start });
  const replacement = await runCompleteHttpCases({ manifest, target, submit, terminal, readNativePlan, events, requests, event,
    setPhase: (value) => { phase = value; }, baseline: { nativePlan: await readNativePlan() }, after });
  assert.ok(replacement.results.length > 0 && eventError === undefined);
  const result = { passed: true, protocol: 'managed-v3', scope: 'remaining HTTP cases from a verified release on the isolated platform',
    after, start, final: replacement.final, replacementCases: replacement.results, requests: requests.filter(({ kind }) => kind === 'short').length,
    versions: JSON.parse(await docker('version', '--format', '{{json .}}')), compose: await docker('compose', 'version', '--short'), node: process.version,
    os: await readFile('/etc/os-release', 'utf8'), kernel: os.release(), architecture: os.arch() };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)); event('passed', result);
};
try {
  stream = spawn('docker', ['events', '--filter', 'label=com.kayra.app=' + manifest.app, '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'] }); streamExit = once(stream, 'exit');
  stream.on('error', () => { eventError = 'Docker event observer failed'; }); let partial = '';
  stream.stdout.setEncoding('utf8'); stream.stdout.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk); if (bytes > 8 * 1024 * 1024) { eventError = 'Docker event observer exceeded evidence bound'; stream.kill('SIGTERM'); return; }
    partial += chunk; const lines = partial.split('\n'); partial = lines.pop();
    for (const line of lines) if (line) { try { events.push(JSON.parse(line)); } catch { eventError = 'invalid Docker event evidence'; } }
  });
  stream.stderr.on('data', () => { eventError = 'Docker event observer reported an error'; });
  streamExit.then(() => { if (phase !== 'complete') eventError = 'Docker event observer ended prematurely'; });
  let previousCpu;
  sampler = setInterval(async () => {
    try {
      const memory = Object.fromEntries((await readFile('/proc/meminfo', 'utf8')).split('\n').flatMap((line) => { const match = /^(MemTotal|MemAvailable):\s+(\d+) kB$/.exec(line); return match ? [[match[1], Number(match[2]) * 1024]] : []; }));
      const cpu = (await readFile('/proc/stat', 'utf8')).split('\n')[0].trim().split(/\s+/).slice(1).map(Number); const total = cpu.reduce((sum, value) => sum + value, 0); const idle = cpu[3] + cpu[4];
      const cpuBusyFraction = previousCpu === undefined ? null : 1 - (idle - previousCpu.idle) / Math.max(1, total - previousCpu.total); previousCpu = { total, idle };
      metrics.push({ at: Date.now(), phase, memory, cpuBusyFraction });
    } catch { eventError = 'resource observer failed'; }
  }, 1000);
  if (manifest.resumeAfter !== undefined) {
    await resumeHttp(manifest.resumeAfter);
  } else {
    await pause(500); const a = await submit('A'); const activeA = await terminal(a.receipt); assert.equal(activeA.verifiedActive.plan, a.receipt.plan);
    const target = { host: manifest.host, ca: await readFile('/var/lib/kayra/swarm/lab-ca.pem', 'utf8') };
    const response = await request(target); assert.equal(response.status, 200); assert.equal(response.release, 'A');
    const initialLedger = await ledger(); assert.equal(initialLedger.calls[a.receipt.request + ':schema'], 1); assert.equal(initialLedger.effects[a.receipt.request + ':schema'], 1);
    phase = 'baseline'; stop = traffic(target, (value) => requests.push({ ...value, phase })); await pause(30000);
    assert.ok(requests.filter((value) => value.phase === 'baseline').length >= 570);
    phase = 'migration'; const b = await submit('B');
    await wait(async () => (await ledger()).effects[b.receipt.request + ':schema'] === 1, 'app-owned migration effect');
    const incarnation = activeA.incarnation; const migration = jobName({ app: manifest.app, incarnation, run: b.receipt.request, step: 'schema', purpose: 'migration', attempt: 1 });
    const originalJob = JSON.parse(await docker('inspect', migration))[0]; assert.equal(originalJob.State.Running, true);
    const deployers = (await docker('ps', '-q', '--filter', 'label=com.docker.compose.project=platform', '--filter', 'label=com.docker.compose.service=deployer', '--filter', 'label=com.docker.compose.oneoff=False')).split('\n'); assert.equal(deployers.length, 1);
    const deployer = deployers[0]; const originalStart = await docker('inspect', deployer, '--format', '{{.State.StartedAt}}'); const interrupted = await status();
    const pending = managed ? interrupted.operation : interrupted.preparation;
    assert.equal(managed ? pending.run : pending.request, b.receipt.request);
    assert.equal(pending.deadline, b.receipt.deadline);
    if (managed) assert.equal(pending.admissionDeadline, b.receipt.admissionDeadline);
    phase = 'interruption'; event('before-coordinator-kill', { status: interrupted, job: { id: originalJob.Id, running: originalJob.State.Running } });
    await docker('kill', '--signal', 'KILL', deployer); await pause(3000);
    const independent = JSON.parse(await docker('inspect', originalJob.Id))[0]; assert.equal(independent.State.Running, true); event('migration-continued-without-coordinator', { id: independent.Id, running: true });
    await docker('start', deployer); await wait(async () => { try { return await status(); } catch { return undefined; } }, 'coordinator restart', 30000);
    assert.notEqual(await docker('inspect', deployer, '--format', '{{.State.StartedAt}}'), originalStart);
    phase = 'recovery'; const activeB = await terminal(b.receipt); assert.equal(activeB.verifiedActive.plan, b.receipt.plan); assert.equal(activeB.verifiedActive.commit, manifest.commits.B);
    const replay = await ctl('lifecycle', 'prepare', manifest.app, manifest.commits.B, b.receipt.request); assert.equal(replay.deadline, b.receipt.deadline); assert.equal(replay.plan, b.receipt.plan); assert.equal(replay.phase, managed ? 'complete' : 'succeeded');
    if (managed) {
      assert.equal(replay.outcome, 'deployed');
      assert.equal(replay.admissionDeadline, b.receipt.admissionDeadline);
      b.nativePlan = await readNativePlan();
    }
    phase = 'stable'; await pause(30000); await stop(); stop = undefined;
    const snapshot = await ledger(); for (const identity of [a.receipt.request, b.receipt.request]) { assert.equal(snapshot.calls[identity + ':schema'], 1); assert.equal(snapshot.effects[identity + ':schema'], 1); }
    const starts = events.filter((value) => value.Action === 'start' && value.Actor?.Attributes?.['com.kayra.job']);
    const probeName = jobName({ app: manifest.app, incarnation, run: b.receipt.request, step: 'schema', purpose: 'probe', attempt: 1 });
    const expectedJobs = [jobName({ app: manifest.app, incarnation, run: a.receipt.request, step: 'schema', purpose: 'migration', attempt: 1 }), migration, probeName];
    assert.deepEqual(starts.map((value) => value.Actor.Attributes['com.kayra.job']).sort(), expectedJobs.sort()); assert.ok(starts.every((value) => value.Actor.Attributes['com.kayra.barrier'] === 'false'));
    const failures = requests.filter((value) => value.error !== undefined || value.status !== 200); const premature = prematureCandidateRequests(requests, 'B'); assert.equal(failures.length, 0); assert.equal(premature.length, 0);
    assert.ok(requests.some((value) => value.release === 'A') && requests.filter((value) => value.phase === 'stable').every((value) => value.release === 'B'));
    assert.ok(requests.filter((value) => value.phase === 'stable').length >= 570); assert.ok(requests.some((value) => value.connection === 'fresh') && requests.some((value) => value.connection === 'persistent'));
    assert.equal(eventError, undefined);
    const rate = (requests.length - 1) / ((requests.at(-1).at - requests[0].at) / 1000); const maxGapMs = Math.max(...requests.map((value) => value.gapMs ?? 0));
    assert.ok(rate >= 19, 'traffic observer missed its request rate'); assert.ok(maxGapMs <= 250, 'traffic observer was suspended or starved');
    const failedMigration = events.find((value) => value.Action === 'die' && value.Actor?.ID === originalJob.Id && value.Actor.Attributes.exitCode === '1');
    const probeStart = starts.find((value) => value.Actor.Attributes['com.kayra.job'] === probeName);
    const probeFinished = events.find((value) => value.Action === 'die' && value.Actor?.ID === probeStart?.Actor.ID && value.Actor.Attributes.exitCode === '0');
    const candidateStarted = events.find((value) => value.Action === 'start' && !value.Actor?.Attributes?.['com.kayra.job'] && value.Actor?.Attributes?.['com.kayra.plan'] === b.nativePlan);
    assert.ok(failedMigration && probeFinished && candidateStarted); assert.ok(failedMigration.timeNano < probeStart.timeNano && probeFinished.timeNano < candidateStarted.timeNano);
    const replacement = managed && manifest.commits.C !== undefined
      ? await runCompleteHttpCases({ manifest, target, submit, terminal, readNativePlan, events, requests, event,
        setPhase: (value) => { phase = value; }, baseline: b })
      : null;
    phase = 'complete'; stream.kill('SIGTERM'); await streamExit; clearInterval(sampler); sampler = undefined;
    const versions = JSON.parse(await docker('version', '--format', '{{json .}}'));
    const sharedImages = {};
    for (const service of ['traefik', 'socket-proxy']) {
      const ids = (await docker('ps', '-q', '--filter', 'label=com.docker.compose.project=platform', '--filter', 'label=com.docker.compose.service=' + service, '--filter', 'label=com.docker.compose.oneoff=False')).split('\n'); assert.equal(ids.length, 1);
      sharedImages[service] = await docker('inspect', ids[0], '--format', '{{.Config.Image}}');
    }
    const ledgerImage = await docker('inspect', manifest.ledger, '--format', '{{.Image}}');
    const ledgerImageReference = await docker('inspect', manifest.ledger, '--format', '{{.Config.Image}}');
    const result = { passed: true, protocol: managed ? 'managed-v3' : 'complete-v2', scope: 'real registered builder artifacts, app-owned HTTP ledger, migration/probe containers, coordinator restart and routed TLS HTTP; no SQL engine or retained-volume acceptance',
      a, b, initial: activeA, interrupted, final: replacement?.final ?? activeB, replay, ledger: snapshot, migrationContinuedWithoutCoordinator: true, migrationStarts: 2, probeStarts: 1,
      replacementCases: replacement?.results ?? [], requests: requests.filter((value) => value.kind === 'short').length,
      failedRequests: failures.length + (replacement?.results.reduce((total, value) => total + value.requests.failed, 0) ?? 0),
      prematureExposure: premature.length, achievedRequestsPerSecond: rate, maxRequestStartGapMs: maxGapMs, appProbeRecoveredFailure: true, previousReleaseDrainingResponses: requests.filter((value) => value.release === 'A' && value.ready === false).length, versions, sharedImages, ledgerImage, ledgerImageReference, compose: await docker('compose', 'version', '--short'), node: process.version, os: await readFile('/etc/os-release', 'utf8'), kernel: os.release(), architecture: os.arch() };
    await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)); event('passed', result);
  }
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), phase, manifest }, null, 2)); console.error(JSON.stringify({ error: String(error), output })); process.exitCode = 1;
} finally {
  if (stop) await stop(); if (sampler) clearInterval(sampler); if (stream && stream.exitCode === null) { phase = 'complete'; stream.kill('SIGTERM'); await streamExit; }
  await writeFile(join(output, 'requests.jsonl'), requests.map((value) => JSON.stringify(value)).join('\n') + '\n');
  await writeFile(join(output, 'trace.json'), JSON.stringify(trace, null, 2)); await writeFile(join(output, 'docker-events.json'), JSON.stringify(events, null, 2)); await writeFile(join(output, 'resources.json'), JSON.stringify(metrics, null, 2));
}
