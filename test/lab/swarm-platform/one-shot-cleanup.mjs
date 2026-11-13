import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { jobName, jobPlanDigest, parseJobPlan } from '../../../cli/src/contracts/one-shot-job.ts';
import { jobCleanup } from '../../../cli/src/server/deployment/job-cleanup.ts';
import { openJournal } from '../../../cli/src/server/deployment/journal.ts';
import { openArtifactStore } from '../../../cli/src/server/deployment/artifact-store.ts';
import { oneShotJob, oneShotCleanup } from '../../../cli/src/server/runtime/one-shot-job.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';

const [mode, directory, checkpoint] = process.argv.slice(2); assert.ok(directory);
const api = dockerApi(); const native = oneShotJob(api); const cleanup = oneShotCleanup(api); const run = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ports = async (path, point) => ({ ...await openArtifactStore(join(path, 'artifacts')), now: Date.now, authorize: async () => true,
  native: { ...cleanup, fence: async (...args) => {
    if (point === 'before-fence') process.kill(process.pid, 'SIGKILL');
    const result = await cleanup.fence(...args);
    if (point === 'after-fence') { assert.equal(result, 'acknowledged'); process.kill(process.pid, 'SIGKILL'); }
    return result;
  } },
});
if (mode === 'child') {
  const journal = await openJournal(join(directory, 'cleanup'), 'existing'); const owner = jobCleanup(journal, await ports(directory, checkpoint));
  await owner.tick(); throw new Error('cleanup writer missed kill checkpoint');
}
assert.equal(mode, 'run'); await mkdir(directory, { mode: 0o700 }); const reports = []; const app = 'job-cleanup-lab-' + randomUUID().slice(0, 8); let observer; let observerClosed; let eventError; const chunks = []; let eventBytes = 0;
try {
  const deployer = (await run('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=platform', '--filter', 'label=com.docker.compose.service=deployer', '--filter', 'label=com.docker.compose.oneoff=False'])).stdout.trim(); assert.match(deployer, /^[0-9a-f]{12,64}$/);
  const source = JSON.parse((await run('docker', ['inspect', deployer])).stdout)[0].Image; const tag = `localhost:5000/${app}/web:fixture`;
  await run('docker', ['tag', source, tag]); await run('docker', ['push', tag], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const image = JSON.parse((await run('docker', ['image', 'inspect', tag])).stdout)[0].RepoDigests.find((value) => value.startsWith(`localhost:5000/${app}/web@sha256:`)); assert.ok(image);
  observer = spawn('docker', ['events', '--since', String(Math.floor(Date.now() / 1000)), '--filter', 'type=container', '--filter', 'label=com.kayra.app=' + app, '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
  observerClosed = new Promise((resolve) => observer.once('close', resolve));
  observer.on('error', () => { eventError = 'event observer unavailable'; });
  observer.stdout.on('data', (chunk) => { eventBytes += chunk.length; if (eventBytes > 2 * 1024 * 1024) { eventError = 'event overflow'; observer.kill('SIGTERM'); } else chunks.push(chunk); });
  observer.stderr.on('data', () => { eventError = 'event observer failed'; });
  await pause(250);
  const contexts = [];
  for (const point of ['before-fence', 'after-fence']) {
    const path = join(directory, point); await mkdir(path, { mode: 0o700 }); const at = Date.now();
    const checked = parseJobPlan({ version: 1, scope: { app, incarnation: randomUUID(), run: randomUUID(), step: 'cleanup', purpose: 'migration', attempt: 1 },
      image, command: ['-e', 'setTimeout(()=>process.exit(0),120000)'], entrypoint: ['node'], environment: {}, networks: [],
      resources: { memoryBytes: 64 * 1024 * 1024, nanoCpus: 100_000_000 }, deadline: at + 5000, stopGraceSeconds: 30 });
    assert.ok(checked.ok, checked.error); const job = checked.value;
    const artifacts = await openArtifactStore(join(path, 'artifacts')); assert.equal(await artifacts.retain(JSON.stringify(job)), jobPlanDigest(job));
    assert.equal(await native.create(job, {}), 'acknowledged'); const created = await native.observe(job); assert.equal(created.status, 'owned');
    assert.equal(await native.start(job, created.id), 'acknowledged'); contexts.push({ path, point, job, container: created.id, startedAt: at });
  }
  const expired = Math.max(...contexts.map((value) => value.job.deadline + 30000)) + 1000;
  console.log(JSON.stringify({ checkpoint: 'waiting-for-original-cleanup-expiry', deadline: expired }));
  while (Date.now() < expired) await pause(Math.min(1000, expired - Date.now()));
  for (const context of contexts) {
    const { path, point, job, container, startedAt } = context; const before = await native.observe(job); assert.equal(before.status, 'owned'); assert.equal(before.state, 'running');
    const at = Date.now(); const authority = { version: 1, action: randomUUID(), job: jobPlanDigest(job), createdAt: at, deadline: at + 30000 };
    assert.equal(await native.fence(job, container, authority.deadline), 'refused');
    await writeFile(join(path, 'context.json'), JSON.stringify({ ...context, authority }));
    await mkdir(join(path, 'cleanup'), { mode: 0o700 });
    const initial = await openJournal(join(path, 'cleanup')); await jobCleanup(initial, await ports(path)).prepare(authority); await initial.close();
    const killed = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', path, point], { stdio: ['ignore', 'ignore', 'pipe'] });
      const errors = []; child.stderr.on('data', (chunk) => errors.push(chunk)); child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, stderr: Buffer.concat(errors).toString() }));
    }); assert.equal(killed.signal, 'SIGKILL', JSON.stringify(killed));
    const journal = await openJournal(join(path, 'cleanup'), 'existing'); const owner = jobCleanup(journal, await ports(path));
    const recovered = await owner.read(); assert.deepEqual(recovered.targets, [container]); assert.equal(recovered.authority.deadline, authority.deadline);
    let final;
    for (let count = 0; count < 5; count++) { final = await owner.tick(); if (final.phase === 'complete') break; await pause(100); }
    assert.equal(final.phase, 'complete'); assert.equal(final.authority.deadline, authority.deadline);
    assert.equal((await api.request('GET', `/containers/${container}/json`)).status, 404);
    const barrier = await cleanup.observe(job); assert.equal(barrier.status, 'owned'); assert.equal(barrier.id, final.barrier); assert.equal(barrier.state, 'created'); assert.equal(barrier.barrier, true);
    const inspect = await api.request('GET', `/containers/${barrier.id}/json`); assert.deepEqual(inspect.value.Config.Healthcheck.Test, ['NONE']); assert.equal(inspect.value.HostConfig.NetworkMode, 'none');
    await pause(100); assert.equal(eventError, undefined);
    const events = Buffer.concat(chunks).toString();
    const starts = events.trim().split('\n').filter(Boolean).map((value) => JSON.parse(value)).filter((value) => value.Action === 'start' && value.Actor.ID === container);
    assert.equal(starts.length, 1);
    assert.equal(events.trim().split('\n').filter(Boolean).map((value) => JSON.parse(value)).some((value) => value.Action === 'start' && value.Actor.ID === barrier.id), false);
    await writeFile(join(path, 'events.jsonl'), events); await writeFile(join(path, 'proof.json'), JSON.stringify(final)); await journal.close();
    assert.equal((await api.request('DELETE', `/containers/${barrier.id}?v=true`)).status, 204);
    reports.push({ point, originalDeadline: job.deadline, cleanupDeadline: authority.deadline, originalContainer: container, barrier: barrier.id, starts: starts.length, passed: true }); console.log(JSON.stringify(reports.at(-1)));
  }
  observer.kill('SIGTERM'); await observerClosed; observer = undefined; assert.equal(eventError, undefined);
  const engine = (await api.request('GET', '/version')).value;
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, reports, app, image, engine: engine.Version, api: engine.ApiVersion, node: process.version,
    scope: 'native cleanup adapter and private synchronized owner with fixture authorization; no operator catalog or deployment-outcome resolution claim' }, null, 2));
} catch (error) {
  if (observer) { observer.kill('SIGTERM'); await observerClosed; }
  await writeFile(join(directory, 'failure.json'), JSON.stringify({ error: String(error), app, reports }, null, 2));
  console.error(`Preserved failed cleanup lab at ${directory}; inspect context.json and exact owned IDs before cleanup.`); throw error;
}
