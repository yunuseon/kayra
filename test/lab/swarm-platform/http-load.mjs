import { nativeHttpIntent } from './http-intent.mjs';
// Run on the isolated VM. Workload writes go only through the real deployer's ctl.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { swarmService } from '../../../cli/src/server/runtime/swarm-service.ts';
import { request, traffic } from './http-probe.mjs';

const run = promisify(execFile); const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const [manifestPath, output, mode = 'run'] = process.argv.slice(2);
assert.ok(manifestPath && output && ['prepare', 'run'].includes(mode), 'usage: http-load.mjs <manifest.json> <new-results-directory> [prepare|run]');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.version, 1); assert.equal(manifest.app, 'rollout-http'); assert.equal(manifest.host, 'rollout.lab.test');
await mkdir(output, { mode: 0o700 });
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const env = { ...process.env, COMPOSE_FILE: 'docker-compose.yml:docker-compose.ci.yml:docker-compose.swarm.yml:registration-lab.yml' };
const compose = async (...args) => (await run('docker', ['compose', ...args], { cwd: '/opt/platform', env, timeout: 45 * 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const ctl = async (...args) => JSON.parse(await compose('exec', '-T', 'deployer', 'kayra-deployer', 'ctl', ...args));
if (mode === 'prepare') {
  const builds = [];
  for (const commit of Object.values(manifest.commits)) builds.push(await ctl('build', manifest.app, commit));
  await writeFile(join(output, 'builds.json'), JSON.stringify(builds, null, 2) + '\n');
  const router = await readFile('/opt/platform/traefik/traefik.yml', 'utf8');
  const authority = JSON.parse(await readFile('/var/lib/kayra/swarm/authority.json', 'utf8'));
  const source = JSON.parse(await readFile(new URL('../../../.kayra-lab-source.json', import.meta.url), 'utf8'));
  const environment = { recordedAt: new Date().toISOString(), node: process.version, os: await readFile('/etc/os-release', 'utf8'),
    kernel: (await run('uname', ['-a'])).stdout.trim(), docker: JSON.parse((await run('docker', ['version', '--format', '{{json .}}'])).stdout),
    compose: (await compose('version', '--short')), platformImages: await compose('images', '--format', 'json'), authority, source,
    routerStaticSha256: createHash('sha256').update(router).digest('hex'), swarmProvider: YAML.parse(router).providers.swarm,
    images: await ctl('pins') };
  await writeFile(join(output, 'environment.json'), JSON.stringify(environment, null, 2) + '\n');
  console.log(JSON.stringify({ prepared: builds.length, output }));
} else {
  const writers = []; const children = []; const results = []; let stopTraffic; let sampling; let caseAccess = []; let caseDocker = []; let loggingError; let closing = false; let phase = 'setup'; let currentCase = null; let previousCpu; let sampleBusy = false;
  const log = (name) => {
    const stream = createWriteStream(join(output, name), { flags: 'wx', mode: 0o600 }); writers.push(stream);
    stream.on('error', (error) => { loggingError = error.code ?? 'write-error'; });
    return (value) => stream.write(JSON.stringify(value) + '\n');
  };
  const events = log('observer.jsonl'); const metrics = log('vm.jsonl'); const dockerEvents = log('docker-events.jsonl'); const access = log('traefik-access.jsonl');
  const announce = (kind, fields = {}) => { const value = { at: Date.now(), monotonicMs: performance.now(), phase, case: currentCase, kind, ...fields }; events(value); console.log(JSON.stringify(value)); };
  const checkLogs = () => { if (loggingError) throw new Error('evidence writer failed: ' + loggingError); };
  const startStream = (args, consume, includeStderr = false) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise((resolve) => child.once('close', resolve)); children.push({ child, closed });
    createInterface({ input: child.stdout }).on('line', consume);
    if (includeStderr) createInterface({ input: child.stderr }).on('line', consume);
    else child.stderr.on('data', () => {});
    child.on('error', () => { loggingError = 'collector-start'; });
    child.on('exit', (code, signal) => { if (!closing) loggingError = 'collector-exit'; });
    return child;
  };
  try {
    const startedAt = Date.now();
    startStream(['events', '--filter', 'label=com.kayra.app=' + manifest.app, '--format', '{{json .}}'], (line) => {
      try { const value = JSON.parse(line); caseDocker.push(value); dockerEvents(value); } catch { loggingError = 'malformed-docker-event'; }
    });
    const traefik = await compose('ps', '-q', 'traefik');
    startStream(['logs', '--follow', '--since', new Date(startedAt).toISOString(), traefik], (line) => {
      try {
        const value = JSON.parse(line);
        if (value.RequestHost !== manifest.host) return;
        const record = Object.fromEntries(['StartUTC', 'RequestHost', 'RequestPath', 'RequestMethod', 'DownstreamStatus', 'OriginStatus', 'ServiceAddr', 'ServiceURL', 'ServiceName', 'RouterName', 'RetryAttempts', 'Duration', 'OriginDuration'].flatMap((key) => key in value ? [[key, value[key]]] : []));
        caseAccess.push(record); access(record);
      } catch { /* Non-access router diagnostics are outside this fixture's evidence. */ }
    }, true);
    const sample = async () => {
      if (sampleBusy) return; sampleBusy = true;
      try {
        const mem = Object.fromEntries((await readFile('/proc/meminfo', 'utf8')).trim().split('\n').map((line) => [line.split(':')[0], Number(line.split(/\s+/)[1]) * 1024]));
        const cpu = (await readFile('/proc/stat', 'utf8')).split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
        const total = cpu.reduce((a, b) => a + b, 0); const idle = cpu[3] + cpu[4];
        const busy = previousCpu === undefined ? null : 1 - (idle - previousCpu.idle) / Math.max(1, total - previousCpu.total); previousCpu = { total, idle };
        metrics({ at: Date.now(), phase, case: currentCase, memoryTotalBytes: mem.MemTotal, memoryAvailableBytes: mem.MemAvailable, cpuBusyFraction: busy });
      } catch { loggingError = 'resource-collector'; } finally { sampleBusy = false; }
    };
    await sample(); sampling = setInterval(() => { void sample(); }, 1000);
    const target = { host: manifest.host, ca: await readFile('/var/lib/kayra/swarm/lab-ca.pem', 'utf8') };
    const native = swarmService(dockerApi()); const status = () => ctl('lifecycle', 'status', manifest.app);
    const registration = await status(); const scope = { app: manifest.app, service: 'web', incarnation: registration.incarnation };
    const wait = async (action, label, milliseconds = 190000) => {
      const until = performance.now() + milliseconds;
      while (performance.now() < until) { checkLogs(); const result = await action(); if (result) return result; await pause(250); }
      throw new Error('timed out: ' + label);
    };
    const submit = async (commit, id) => {
      const accepted = await ctl('lifecycle', 'prepare', manifest.app, commit, id);
      assert.equal(accepted.request, id); assert.equal(accepted.commit, commit);
      assert.ok(!['succeeded', 'failed', 'cancelled', 'held'].includes(accepted.phase), 'request already settled; do not reuse it for a new measurement');
      accepted.nativePlan = nativeHttpIntent(accepted, await ctl("preview", manifest.app, commit));
      return accepted;
    };
    const projection = async (accepted) => {
      const value = await status(); const operation = value.operation;
      if (operation === null) {
        assert.equal(value.preparation.request, accepted.request);
        assert.ok(!['failed', 'held', 'cancelled'].includes(value.preparation.phase), 'HTTP fixture preparation did not converge'); return undefined;
      }
      assert.equal(operation.request, accepted.request);
      accepted.httpDeadline ??= operation.updateDeadline;
      assert.equal(operation.updateDeadline, accepted.httpDeadline);
      assert.ok(accepted.version === 1 ? accepted.httpDeadline === accepted.deadline : accepted.httpDeadline <= accepted.deadline);
      return value;
    };
    const terminal = async (accepted) => wait(async () => {
      const projected = await projection(accepted); if (projected === undefined) return undefined;
      const observed = await native.observe(scope); events({ at: Date.now(), phase, case: currentCase, kind: 'observation', status: projected, native: observed });
      assert.notEqual(projected.operation.phase, 'held', 'intervention required; preserve this run');
      return ['succeeded', 'failed', 'cancelled'].includes(projected.operation.phase) ? { status: projected, native: observed, at: Date.now() } : undefined;
    }, 'durable operation ' + accepted.request);
    const initial = await submit(manifest.commits.A, manifest.initialRequest);
    const baseline = await terminal(initial); assert.equal(baseline.status.operation.phase, 'succeeded');
    const appLog = createWriteStream(join(output, 'application.log'), { flags: 'wx', mode: 0o600 }); writers.push(appLog);
    appLog.on('error', () => { loggingError = 'application-log'; });
    const application = startStream(['service', 'logs', '--raw', '--timestamps', '--follow', '--since', new Date(startedAt).toISOString(), 'kayra-' + manifest.app + '--web'], (line) => appLog.write(line + '\n'), true);
    assert.ok(application.pid);
    phase = 'baseline'; announce('baseline-start');
    const baselineRequests = []; const baselineWrite = log('baseline-requests.jsonl');
    stopTraffic = traffic(target, (value) => { baselineRequests.push(value); baselineWrite(value); });
    await pause(30000); await stopTraffic(); stopTraffic = undefined;
    assert.ok(baselineRequests.length >= 570); assert.ok(baselineRequests.every((item) => item.status === 200 && item.error === undefined && item.release === 'A' && item.ready));
    announce('baseline-complete', { requests: baselineRequests.length });
    for (const item of manifest.matrix) {
      currentCase = { name: item.name, repeat: item.repeat }; phase = 'reset'; announce('case-start');
      const reset = await submit(manifest.commits.A, item.resetRequest); const resetOutcome = await terminal(reset); assert.equal(resetOutcome.status.operation.phase, 'succeeded');
      const before = await native.observe(scope); assert.equal(before.status, 'owned');
      caseAccess = []; caseDocker = [];
      const host = JSON.parse(await readFile('/var/lib/kayra/swarm/authority.json', 'utf8'));
      const addresses = JSON.parse((await run('docker', ['service', 'inspect', before.id, '--format', '{{json .Endpoint.VirtualIPs}}'])).stdout);
      const vip = addresses.find((address) => address.NetworkID === host.network.id)?.Addr.split('/')[0]; assert.ok(vip);
      const values = []; const requests = log(`${item.name}-${item.repeat}-requests.jsonl`);
      phase = 'preparation'; stopTraffic = traffic(target, (value) => { values.push(value); requests(value); });
      await pause(10000);
      let long; let longHeaders;
      if (item.name === 'long-request') {
        const headers = Promise.withResolvers();
        long = request(target, { path: '/slow?ms=20000', timeout: 25000, onHeaders: (value) => { longHeaders = value; headers.resolve(value); } });
        await Promise.race([headers.promise, pause(3000).then(() => { throw new Error('long request did not begin'); })]);
        assert.equal(longHeaders.release, 'A'); announce('long-request-started', longHeaders);
      }
      phase = 'update'; const submittedAt = Date.now(); const accepted = await submit(item.commit, item.updateRequest); announce('update-accepted', { accepted, submittedAt });
      if (item.name === 'observer-interruption') {
        const acknowledged = await wait(async () => {
          const observed = await native.observe(scope);
          if (observed.status !== 'owned' || observed.id !== before.id || observed.version <= before.version || observed.taskPlan !== accepted.nativePlan) return undefined;
          const projected = await projection(accepted); if (projected === undefined) return undefined;
          assert.ok(['applying', 'verifying'].includes(projected.operation.phase), 'interruption must precede terminal convergence'); return observed;
        }, 'native update acknowledgement', 90000);
        const deployer = await compose('ps', '-q', 'deployer');
          const previousStart = (await run('docker', ['inspect', deployer, '--format', '{{.State.StartedAt}}'])).stdout.trim();
          announce('coordinator-kill', { native: acknowledged, previousStart });
        await run('docker', ['kill', '--signal', 'KILL', deployer]); await pause(3000);
        events({ at: Date.now(), kind: 'runtime-after-coordinator-kill', native: await native.observe(scope) });
        await run('docker', ['start', deployer]);
        await wait(async () => { try { return await status(); } catch { return undefined; } }, 'coordinator restart', 20000);
        const restartedAt = (await run('docker', ['inspect', deployer, '--format', '{{.State.StartedAt}}'])).stdout.trim();
          assert.notEqual(restartedAt, previousStart); announce('coordinator-restarted', { previousStart, restartedAt });
      }
      phase = 'convergence'; const outcome = await terminal(accepted); const convergedAt = Date.now();
      const expected = ['never-ready', 'crash-after-ready'].includes(item.name) ? 'A' : item.release;
      assert.equal(outcome.status.operation.phase, expected === 'A' ? 'failed' : 'succeeded');
      assert.equal(outcome.status.verifiedActive.commit, expected === 'A' ? manifest.commits.A : item.commit);
      assert.equal(outcome.status.operation.updateDeadline, accepted.httpDeadline);
      phase = 'stable'; announce('runtime-converged', { outcome, expected, elapsedMs: convergedAt - submittedAt });
      await pause(30000); await stopTraffic(); stopTraffic = undefined;
      const longResult = long === undefined ? null : await long;
      const failures = values.filter((value) => value.error !== undefined || value.status !== 200);
      const premature = values.filter((value) => value.release === item.release && value.ready !== true);
      const gaps = values.map((value) => value.gapMs ?? 0); const duration = Math.max(...values.map((value) => value.at)) - Math.min(...values.map((value) => value.at));
      const stable = values.filter((value) => value.at >= convergedAt);
      const backend = caseAccess.filter((record) => typeof record.ServiceAddr === 'string' && record.ServiceAddr !== '');
      const vipDiscovery = backend.length > 0 && backend.every((record) => record.ServiceAddr === vip + ':8080');
      const retryAttempts = caseAccess.reduce((sum, record) => sum + Number(record.RetryAttempts ?? 0), 0);
      const candidateEvents = caseDocker.filter((event) => event.Actor?.Attributes?.['com.kayra.plan'] === accepted.nativePlan);
      const healthy = candidateEvents.find((event) => event.Action === 'health_status: healthy');
      const crash = candidateEvents.find((event) => event.Action === 'die' && event.Actor?.Attributes?.exitCode === '42');
      const healthyBeforeCrash = healthy !== undefined && crash !== undefined && healthy.timeNano < crash.timeNano;
      const ordered = [...values].sort((a, b) => a.at - b.at); let firstFailure; let lastFailure; let longestFailureIntervalMs = 0;
      for (const value of ordered) {
        if (value.error !== undefined || value.status !== 200) { firstFailure ??= value.at; lastFailure = value.at; longestFailureIntervalMs = Math.max(longestFailureIntervalMs, lastFailure - firstFailure); }
        else { firstFailure = undefined; lastFailure = undefined; }
      }
      const result = { ...item, submittedAt, convergedAt, elapsedMs: convergedAt - submittedAt, requests: values.length, failedRequests: failures.length,
        prematureExposure: premature.length, freshRequests: values.filter((value) => value.connection === 'fresh').length, persistentRequests: values.filter((value) => value.connection === 'persistent').length,
        maxRequestStartGapMs: Math.max(...gaps), achievedRequestsPerSecond: (values.length - 1) / (duration / 1000),
        failureStartsAt: failures.length === 0 ? null : Math.min(...failures.map((value) => value.at)), failureEndsAt: failures.length === 0 ? null : Math.max(...failures.map((value) => value.endedAt)),
        vip, accessRecords: caseAccess.length, backendAddressRecords: backend.length, vipDiscovery, retryAttempts, healthyBeforeCrash, longestSampledFailureIntervalMs: longestFailureIntervalMs,
        long: longResult, stableExpectedRelease: stable.length >= 570 && stable.every((value) => value.release === expected && value.status === 200 && value.error === undefined),
        operation: outcome.status.operation, native: outcome.native };
      result.passed = vipDiscovery && retryAttempts === 0 && (item.name !== 'crash-after-ready' || healthyBeforeCrash) && premature.length === 0 && result.maxRequestStartGapMs < 2000 && result.achievedRequestsPerSecond >= 19 && result.stableExpectedRelease &&
        (item.name === 'crash-after-ready' ? result.elapsedMs <= 90000 : failures.length === 0) &&
        (item.name !== 'never-ready' || result.elapsedMs <= 90000) && (longResult === null || (longResult.status === 200 && longResult.release === 'A' && longResult.task === longHeaders.task && longResult.error === undefined));
      results.push(result); await writeFile(join(output, 'summary.json'), JSON.stringify({ complete: false, continuityMeasured: true, baselineRequests: baselineRequests.length, results }, null, 2) + '\n');
      announce('case-complete', { result }); assert.ok(result.passed, 'continuity case failed; preserve evidence');
    }
    phase = 'complete'; await writeFile(join(output, 'summary.json'), JSON.stringify({ complete: true, passed: results.every((item) => item.passed), continuityMeasured: true, baselineRequests: baselineRequests.length, results }, null, 2) + '\n');
    announce('matrix-complete', { cases: results.length, output });
  } catch (error) {
    announce('experiment-failed', { error: String(error), output }); process.exitCode = 1;
    await writeFile(join(output, 'failure.json'), JSON.stringify({ at: Date.now(), case: currentCase, phase, error: String(error), results }, null, 2) + '\n');
  } finally {
    if (stopTraffic) await stopTraffic(); clearInterval(sampling); while (sampleBusy) await pause(10);
    closing = true; children.forEach(({ child }) => child.kill('SIGTERM'));
    await Promise.all(children.map(({ closed }) => closed));
    await Promise.all(writers.map((stream) => new Promise((resolve) => stream.end(resolve))));
  }
}
