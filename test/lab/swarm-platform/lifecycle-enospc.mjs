// The bounded lab filesystem holds only coordinator metadata, never Docker-root or app data.
import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { nativeHttpIntent } from './http-intent.mjs';
import { prematureCandidateRequests } from './http-observations.mjs';
import { traffic } from './http-probe.mjs';

const [app, commit, identity, storage, output] = process.argv.slice(2);
assert.equal(app, 'rollout-complete'); assert.match(commit, /^[a-f0-9]{40}$/); assert.match(identity, /^[a-f0-9-]{36}$/); assert.ok(storage && output);
await mkdir(output, { mode: 0o700 });
const run = promisify(execFile); const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = { ...process.env, COMPOSE_FILE: 'docker-compose.yml:docker-compose.ci.yml:docker-compose.swarm.yml:registration-lab.yml' };
const docker = async (...args) => (await run('docker', args, { env, cwd: '/opt/platform', timeout: 20000, maxBuffer: 1024 * 1024 })).stdout.trim();
const ctl = async (...args) => JSON.parse(await docker('compose', 'exec', '-T', 'deployer', 'kayra-deployer', 'ctl', ...args));
const status = () => ctl('lifecycle', 'status', app);
const filesystem = async (mode) => JSON.parse((await run('python3', [fileURLToPath(new URL('./lifecycle-filesystem.py', import.meta.url)), mode, storage], { timeout: 20000 })).stdout);
const events = []; const trace = []; const requests = []; const metrics = []; let phase = 'building'; let stop; let sampler; let observer; let observedExit; let evidenceError; let observerComplete = false; let bytes = 0;
const wait = async (condition, label, milliseconds) => {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) { if (evidenceError) throw new Error(evidenceError); const value = await condition(); if (value) return value; await pause(500); }
  throw new Error('timed out: ' + label);
};
try {
  const before = await status(); assert.ok(before.verifiedActive); const previous = before.verifiedActive;
  const build = await ctl('build', app, commit); const preview = await ctl('preview', app, commit); assert.equal(preview.plan.rollout.migrations.length, 0);
  const deployers = (await docker('ps', '-q', '--filter', 'label=com.docker.compose.project=platform', '--filter', 'label=com.docker.compose.service=deployer', '--filter', 'label=com.docker.compose.oneoff=False')).split('\n'); assert.equal(deployers.length, 1); const deployer = deployers[0];
  observer = spawn('docker', ['events', '--filter', 'label=com.kayra.app=' + app, '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
  observedExit = once(observer, 'exit').catch(() => { evidenceError = 'event observer failed'; }); observer.on('error', () => { evidenceError = 'event observer failed'; }); let partial = '';
  observer.stdout.setEncoding('utf8'); observer.stdout.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk); if (bytes > 8 * 1024 * 1024) { evidenceError = 'event evidence exceeded bound'; observer.kill('SIGTERM'); return; }
    partial += chunk; const lines = partial.split('\n'); partial = lines.pop();
    for (const line of lines) if (line) { try { events.push(JSON.parse(line)); } catch { evidenceError = 'invalid event evidence'; } }
  });
  observer.stderr.on('data', () => { evidenceError = 'event observer reported an error'; }); observedExit.then(() => { if (!observerComplete) evidenceError = 'event observer ended prematurely'; });
  sampler = setInterval(async () => {
    try { metrics.push({ at: Date.now(), phase, meminfo: await readFile('/proc/meminfo', 'utf8'), cpu: (await readFile('/proc/stat', 'utf8')).split('\n')[0] }); }
    catch { evidenceError = 'resource observer failed'; }
  }, 1000);
  const target = { host: 'complete.lab.test', ca: await readFile('/var/lib/kayra/swarm/lab-ca.pem', 'utf8') };
  phase = 'baseline'; stop = traffic(target, (value) => requests.push({ ...value, phase })); await pause(30000);
  phase = 'storage-setup'; await docker('stop', '--time', '10', deployer); const staged = await filesystem('stage'); await docker('start', deployer);
  await wait(async () => { try { return await status(); } catch { return undefined; } }, 'coordinator on bounded ext4', 30000);
  const mountProbe = JSON.parse(await docker('exec', deployer, 'node', '--input-type=module', '--eval', 'import {statfs} from "node:fs/promises"; console.log(JSON.stringify({uid:process.getuid(),fs:await statfs("/opt/platform/lifecycle")}))'));
  assert.equal(mountProbe.uid, 1000); assert.ok(mountProbe.fs.blocks * mountProbe.fs.bsize <= 67108864); assert.equal(mountProbe.fs.type, 0xef53);
  phase = 'accepted';
  // The normal control response is consumed in-container and PID 1 is stopped
  // immediately, avoiding another Docker exec/startup between receipt and pause.
  const accepted = JSON.parse(await docker('exec', deployer, 'node', '--input-type=module', '--eval', `
    const send=async(path,body)=>{const response=await fetch('http://127.0.0.1:8091'+path,{method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('control unavailable');return response.json()};
    const receipt=await send('/deployment/prepare',{app:${JSON.stringify(app)},commit:${JSON.stringify(commit)},request:${JSON.stringify(identity)}});
    const status=await send('/deployment/status',{app:${JSON.stringify(app)}});
    if(status.preparation?.phase!=='prepared')throw new Error('observer missed prepared checkpoint');
    process.kill(1,'SIGSTOP');console.log(JSON.stringify({receipt,status}));`));
  const receipt = accepted.receipt; const candidatePlan = nativeHttpIntent(receipt, preview); await pause(1500);
  const candidateEvents = () => events.filter((value) => value.Actor?.Attributes?.['com.kayra.plan'] === candidatePlan && ['create', 'start'].includes(value.Action));
  assert.equal(candidateEvents().length, 0);
  phase = 'full'; const full = await filesystem('fill'); assert.equal(full.uid, 1000); assert.ok(full.availableBytes <= 4096);
  const writeProbe = JSON.parse(await docker('exec', deployer, 'node', '--input-type=module', '--eval', `
    import {writeFile,rm} from 'node:fs/promises';const path='/opt/platform/lifecycle/.lab-enospc-probe';let code;
    try{await writeFile(path,Buffer.alloc(4096),{flag:'wx'});code='unexpected-success'}catch(error){code=error.code}finally{await rm(path,{force:true})}
    console.log(JSON.stringify({uid:process.getuid(),code}));`));
  assert.deepEqual(writeProbe, { uid: 1000, code: 'ENOSPC' });
  await docker('kill', '--signal', 'CONT', deployer); await pause(5000);
  const unavailableWhileFull = await status().then(() => false, () => true); assert.equal(unavailableWhileFull, true); assert.equal(candidateEvents().length, 0);
  phase = 'space-restored'; const released = await filesystem('release'); const releasedAt = Date.now(); assert.ok(released.availableBytes > 16 * 1024 * 1024);
  const stillRequiresRestart = await status().then(() => false, () => true); assert.equal(stillRequiresRestart, true);
  phase = 'restart'; await docker('kill', '--signal', 'KILL', deployer); await docker('start', deployer);
  const reopened = await wait(async () => { try { return await status(); } catch { return undefined; } }, 'reopened journal after space restoration', 30000);
  assert.equal(reopened.preparation.admissionDeadline, accepted.status.preparation.admissionDeadline);
  const replay = await ctl('lifecycle', 'prepare', app, commit, identity); assert.equal(replay.plan, receipt.plan); assert.equal(replay.deadline, receipt.deadline);
  phase = 'reconciling'; const recovered = await wait(async () => {
    const value = await status(); trace.push({ at: Date.now(), value }); const current = value.operation ?? value.preparation; assert.equal(current.request, identity);
    assert.ok(!['held', 'failed', 'cancelled'].includes(current.phase)); return current.phase === 'succeeded' ? value : undefined;
  }, 'same accepted operation converges after ENOSPC', 90000);
  assert.equal(recovered.verifiedActive.plan, receipt.plan); assert.equal(recovered.lastKnownGood.plan, receipt.plan);
  phase = 'stable'; await pause(30000); await stop(); stop = undefined;
  assert.equal(candidateEvents().filter((value) => value.Action === 'start').length, 1);
  assert.ok(candidateEvents().every((value) => value.timeNano / 1e6 >= releasedAt));
  const failures = requests.filter((value) => value.error !== undefined || value.status !== 200); assert.equal(failures.length, 0); const premature = prematureCandidateRequests(requests, 'ENOSPC'); assert.equal(premature.length, 0);
  for (const name of ['baseline', 'stable']) { const values = requests.filter((value) => value.phase === name); assert.ok(values.length >= 570); assert.ok(values.every((value) => value.release === (name === 'baseline' ? 'B' : 'ENOSPC'))); }
  assert.ok(requests.filter((value) => ['storage-setup', 'accepted', 'full', 'space-restored'].includes(value.phase)).every((value) => value.release === 'B'));
  const rate = (requests.length - 1) / ((requests.at(-1).at - requests[0].at) / 1000); const maxGapMs = Math.max(...requests.map((value) => value.gapMs ?? 0)); assert.ok(rate >= 19); assert.ok(maxGapMs <= 250); assert.equal(evidenceError, undefined);
  const result = { passed: true, scope: '64 MiB lab ext4 lifecycle metadata filesystem, accepted-intent ENOSPC and process restart; not Docker-root/inode exhaustion, app-data or host-loss recovery', app, commit, identity, previous, build, receipt, acceptedStatus: accepted.status, staged, mountProbe, full, writeProbe, released, unavailableWhileFull, stillRequiresRestart, releasedAt, reopened, replay, recovered,
    candidateStarts: 1, requests: requests.length, failedRequests: failures.length, prematureExposure: premature.length, achievedRequestsPerSecond: rate, maxRequestStartGapMs: maxGapMs, versions: JSON.parse(await docker('version', '--format', '{{json .}}')), node: process.version };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), phase, app, commit, identity, storage }, null, 2)); process.exitCode = 1; console.error(JSON.stringify({ error: String(error), output }));
} finally {
  if (stop) await stop(); if (sampler) clearInterval(sampler); if (observer && observer.exitCode === null) { observerComplete = true; observer.kill('SIGTERM'); await observedExit; }
  await writeFile(join(output, 'requests.jsonl'), requests.map((value) => JSON.stringify(value)).join('\n') + '\n'); await writeFile(join(output, 'docker-events.json'), JSON.stringify(events, null, 2));
  await writeFile(join(output, 'trace.json'), JSON.stringify(trace, null, 2)); await writeFile(join(output, 'resources.json'), JSON.stringify(metrics, null, 2));
}
