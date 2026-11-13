import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { oneShotJob } from '../../../cli/src/server/runtime/one-shot-job.ts';
import { parseJobPlan } from '../../../cli/src/contracts/one-shot-job.ts';

const [directory] = process.argv.slice(2); assert.ok(directory); await mkdir(directory, { mode: 0o700 });
const api = dockerApi(); const native = oneShotJob(api); const run = promisify(execFile);
const app = 'job-health-lab-' + randomUUID().slice(0, 8); let imageContainer; let job;
try {
  const deployer = (await run('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=platform', '--filter', 'label=com.docker.compose.service=deployer', '--filter', 'label=com.docker.compose.oneoff=False'])).stdout.trim();
  assert.match(deployer, /^[0-9a-f]{12,64}$/);
  const source = JSON.parse((await run('docker', ['inspect', deployer])).stdout)[0].Image;
  const created = await api.request('POST', '/containers/create', { Image: source, Cmd: ['/bin/true'], Labels: { 'com.kayra.lab': app }, HostConfig: { NetworkMode: 'none' } });
  assert.equal(created.status, 201); imageContainer = created.value.Id;
  const tag = `localhost:5000/${app}/web:fixture`;
  await run('docker', ['commit', '--change', 'HEALTHCHECK --interval=1s --timeout=1s --retries=1 CMD node -e "process.exit(1)"', imageContainer, tag]);
  assert.equal((await api.request('DELETE', `/containers/${imageContainer}?v=true`)).status, 204); imageContainer = undefined;
  await run('docker', ['push', tag], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const config = JSON.parse((await run('docker', ['image', 'inspect', tag])).stdout)[0];
  assert.equal(config.Config.Healthcheck.Test[0], 'CMD-SHELL');
  const image = config.RepoDigests.find((value) => value.startsWith(`localhost:5000/${app}/web@sha256:`)); assert.ok(image);
  const startedAt = Date.now(); const parsed = parseJobPlan({ version: 1, scope: { app, incarnation: randomUUID(), run: randomUUID(), step: 'inherited-health', purpose: 'migration', attempt: 1 },
    image, command: ['-e', 'setTimeout(()=>process.exit(0),3500)'], entrypoint: ['node'], environment: {}, networks: [],
    resources: { memoryBytes: 64 * 1024 * 1024, nanoCpus: 100_000_000 }, deadline: startedAt + 60000, stopGraceSeconds: 30 });
  assert.ok(parsed.ok, parsed.error); job = parsed.value;
  assert.equal(await native.create(job, {}), 'acknowledged');
  const container = await native.observe(job); assert.equal(container.status, 'owned'); assert.equal(container.state, 'created');
  const inspect = await api.request('GET', `/containers/${container.id}/json`); assert.deepEqual(inspect.value.Config.Healthcheck.Test, ['NONE']);
  assert.equal(await native.start(job, container.id), 'acknowledged');
  const deadline = Date.now() + 15000; let completed;
  while (Date.now() < deadline) {
    const observation = await native.observe(job);
    if (observation.status === 'owned' && observation.state === 'succeeded') { completed = observation; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(completed); const after = await api.request('GET', `/containers/${container.id}/json`);
  assert.equal(after.value.State.Health, undefined); assert.ok(Date.now() - startedAt >= 3500);
  assert.equal(await native.fence(job, container.id, Date.now() + 30000), 'acknowledged');
  const barrier = await native.observe(job); assert.equal(barrier.status, 'owned'); assert.equal(barrier.barrier, true);
  const inert = await api.request('GET', `/containers/${barrier.id}/json`); assert.deepEqual(inert.value.Config.Healthcheck.Test, ['NONE']); assert.equal(inert.value.State.Status, 'created');
  assert.equal((await api.request('DELETE', `/containers/${barrier.id}?v=true`)).status, 204);
  const engine = (await api.request('GET', '/version')).value;
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, app, image, inheritedHealthcheck: config.Config.Healthcheck,
    jobHealthcheck: inspect.value.Config.Healthcheck, barrierHealthcheck: inert.value.Config.Healthcheck, healthStatePresent: false,
    elapsedMs: Date.now() - startedAt, engine: engine.Version, api: engine.ApiVersion, node: process.version,
    scope: 'native one-shot adapter only; no deployment pipeline or continuity claim' }, null, 2));
  console.log('inherited health check disabled for job and inert barrier');
} catch (error) {
  await writeFile(join(directory, 'failure.json'), JSON.stringify({ error: String(error), app, imageContainer, job }, null, 2));
  console.error(`Preserved failed lab evidence at ${directory}; inspect its exact owned container IDs before cleanup.`);
  throw error;
}
