import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseMigrationSequencePlan } from '../../../cli/src/contracts/migration-sequence.ts';
import { parseJobPlan } from '../../../cli/src/contracts/one-shot-job.ts';
import { migrationAttemptBarrier } from '../../../cli/src/server/deployment/migration-sequence.ts';
import { oneShotJob } from '../../../cli/src/server/runtime/one-shot-job.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { openArtifactStore } from '../../../cli/src/server/deployment/artifact-store.ts';
import { indexedMigrationOwner } from './indexed-migration-owner.mjs';
import { serverCode, migrationCommand, probeCommand } from './migration-fixture.mjs';

const [mode, directory] = process.argv.slice(2); assert.ok(directory); const api = dockerApi(); const native = oneShotJob(api);
const run = promisify(execFile); const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const privateValue = 'synthetic-cancellation-private-value';
const portsFor = async (path) => ({ ...await openArtifactStore(join(path, 'artifacts')), now: Date.now, native,
  materialize: async (job) => Object.fromEntries(Object.entries(job.environment).map(([key, value]) => [key, value.kind === 'literal' ? value.value : privateValue])),
});
const openOwner = async (path, source, initialize = false, checkpoint) => indexedMigrationOwner(path, source, await portsFor(path), checkpoint, initialize);
if (mode === 'child') {
  const source = JSON.parse(await readFile(join(directory, 'source.json'), 'utf8')); const { owner } = await openOwner(directory, source, false, 'after-cancel-intent');
  await owner.cancel(); throw new Error('cancellation writer missed kill checkpoint');
}
assert.equal(mode, 'run'); await mkdir(directory, { mode: 0o700 }); const app = 'cancel-lab-' + randomUUID().slice(0, 8); const reports = [];
let service; let observer; let observerClosed; let eventError; let eventBytes = 0; const chunks = [];
try {
  const host = JSON.parse(await readFile('/var/lib/kayra/swarm/authority.json', 'utf8'));
  const deployer = (await run('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=platform', '--filter', 'label=com.docker.compose.service=deployer', '--filter', 'label=com.docker.compose.oneoff=False'])).stdout.trim(); assert.match(deployer, /^[0-9a-f]{12,64}$/);
  const sourceImage = JSON.parse((await run('docker', ['inspect', deployer])).stdout)[0].Image; const tag = `localhost:5000/${app}/web:fixture`;
  await run('docker', ['tag', sourceImage, tag]); await run('docker', ['push', tag], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const image = JSON.parse((await run('docker', ['image', 'inspect', tag])).stdout)[0].RepoDigests.find((value) => value.startsWith(`localhost:5000/${app}/web@sha256:`)); assert.ok(image);
  const stateName = app + '-state';
  const created = await api.request('POST', '/services/create', { Name: stateName, Labels: { 'com.kayra.lab': app, 'traefik.enable': 'false' },
    TaskTemplate: { ContainerSpec: { Image: image, Command: ['node'], Args: ['--input-type=commonjs', '-e', serverCode],
      Healthcheck: { Test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], Interval: 2e9, Timeout: 1e9, Retries: 3 }, StopGracePeriod: 30e9 },
      Resources: { Limits: { MemoryBytes: 128 * 1024 * 1024, NanoCPUs: 250_000_000 } }, RestartPolicy: { Condition: 'none' },
      Placement: { Constraints: [`node.id==${host.node}`] }, Networks: [{ Target: host.network.id }] }, Mode: { Replicated: { Replicas: 1 } }, EndpointSpec: { Mode: 'vip' } });
  assert.equal(created.status, 201); service = created.value.ID;
  let stateContainer; const readyDeadline = Date.now() + 90000;
  while (Date.now() < readyDeadline) {
    const tasks = (await api.request('GET', '/tasks?filters=' + encodeURIComponent(JSON.stringify({ service: [service] })))).value;
    const task = tasks.find((value) => value.DesiredState === 'running' && value.Status.State === 'running');
    if (task?.Status.ContainerStatus?.ContainerID) {
      const inspect = await api.request('GET', `/containers/${task.Status.ContainerStatus.ContainerID}/json`);
      if (inspect.value.State.Health?.Status === 'healthy') { stateContainer = task.Status.ContainerStatus.ContainerID; break; }
    } await pause(250);
  } assert.ok(stateContainer);
  const snapshot = async () => JSON.parse((await run('docker', ['exec', stateContainer, 'node', '-e', "fetch('http://127.0.0.1:8080/snapshot').then(r=>r.text()).then(s=>process.stdout.write(s))"], { timeout: 10000 })).stdout);
  observer = spawn('docker', ['events', '--since', String(Math.floor(Date.now() / 1000)), '--filter', 'type=container', '--filter', 'label=com.kayra.app=' + app, '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
  observerClosed = new Promise((resolve) => observer.once('close', resolve)); observer.on('error', () => { eventError = 'event observer unavailable'; });
  observer.stdout.on('data', (chunk) => { eventBytes += chunk.length; if (eventBytes > 4 * 1024 * 1024) { eventError = 'event overflow'; observer.kill('SIGTERM'); } else chunks.push(chunk); });
  observer.stderr.on('data', () => { eventError = 'event observer failed'; }); await pause(250);
  for (const item of [
    { name: 'after-create-before-start', checkpoint: 'created', effects: 0, starts: 0 },
    { name: 'after-effect-kill-after-intent', checkpoint: 'effect', kill: true, effects: 1, starts: 2 },
    { name: 'unknown-probe-operator-resolution', checkpoint: 'effect', unknown: true, effects: 1, starts: 2 },
    { name: 'ready-before-handoff', checkpoint: 'ready', effects: 2, starts: 2 },
  ]) {
    const path = join(directory, item.name); await mkdir(path, { mode: 0o700 });
    const parsed = parseMigrationSequencePlan({ version: 1, deployment: 'd'.repeat(64), scope: { app, incarnation: randomUUID(), run: randomUUID() },
      policy: { schedulingSeconds: 90, cleanupSeconds: 30, maximumAttempts: 8, timeoutCeilingSeconds: 90 },
      steps: ['schema', 'seed'].map((id) => ({ definition: { id, service: 'web', command: migrationCommand, timeout_seconds: 30,
        recovery: { kind: 'status-probe', command: probeCommand, timeout_seconds: 15 } },
        template: { version: 1, image, entrypoint: ['node'], environment: {
          DB_HOST: { kind: 'literal', value: stateName }, REPLAY_SAFE: { kind: 'literal', value: '0' },
          MIGRATION_HOLD_MS: { kind: 'literal', value: item.checkpoint === 'effect' ? '10000' : '0' },
          PROBE_MODE: { kind: 'literal', value: item.unknown ? 'unknown' : 'truth' }, TOKEN: { kind: 'secret', key: 'TOKEN' },
        }, resources: { memoryBytes: 128 * 1024 * 1024, nanoCpus: 250_000_000 }, networks: [host.network.id], stopGraceSeconds: 30 } })) });
    assert.ok(parsed.ok, parsed.error); const source = parsed.value; await writeFile(join(path, 'source.json'), JSON.stringify(source));
    let { journal, owner } = await openOwner(path, source, true); const accepted = await owner.prepare(source, Date.now() + 180000); const trace = [];
    const values = (map) => Object.entries(map).filter(([key]) => key.startsWith(source.scope.run + ':')).reduce((sum, [, value]) => sum + value, 0);
    let reached = false;
    for (let count = 0; count < 500 && Date.now() < accepted.deadline; count++) {
      const state = await owner.tick(); trace.push({ at: Date.now(), stage: 'before-cancel', state });
      if (item.checkpoint === 'ready' && state.phase === 'succeeded') { reached = true; break; }
      const attempt = state.steps[0]?.attempts[0];
      if (attempt?.execution?.phase === 'create-intent' && item.checkpoint === 'created') {
        const job = parseJobPlan(JSON.parse(await (await openArtifactStore(join(path, 'artifacts'))).read(attempt.artifact))); assert.ok(job.ok);
        const actual = await native.observe(job.value); if (actual.status === 'owned' && actual.state === 'created' && !actual.barrier) { reached = true; break; }
      }
      if (item.checkpoint === 'effect' && attempt?.execution?.phase === 'observing' && values((await snapshot()).effects) === 1) { reached = true; break; }
      assert.equal(state.phase, 'running'); await pause(100);
    } assert.ok(reached, 'cancellation checkpoint did not converge');
    let persistedCancellation;
    if (item.kill) {
      await journal.close();
      const killed = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', path], { stdio: ['ignore', 'ignore', 'pipe'] }); const errors = [];
        child.stderr.on('data', (chunk) => errors.push(chunk)); child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, stderr: Buffer.concat(errors).toString() }));
      }); assert.equal(killed.signal, 'SIGKILL', JSON.stringify(killed)); ({ journal, owner } = await openOwner(path, source));
      const persisted = await owner.snapshot(); persistedCancellation = persisted.preparation.cancelRequestedAt; assert.ok(persistedCancellation);
      const attempt = persisted.preparation.sequence.steps[0].attempts[0];
      const job = parseJobPlan(JSON.parse(await (await openArtifactStore(join(path, 'artifacts'))).read(attempt.artifact))); assert.ok(job.ok);
      const actual = await native.observe(job.value); assert.equal(actual.status, 'owned'); assert.equal(actual.state, 'running');
    }
    const requested = await owner.cancel(); if (persistedCancellation !== undefined) assert.equal(requested.cancelRequestedAt, persistedCancellation); assert.equal(requested.version, 2); assert.ok(requested.cancelRequestedAt); assert.equal(requested.deadline, accepted.deadline);
    let final;
    for (let count = 0; count < 500 && Date.now() < accepted.deadline; count++) {
      final = await owner.tickCancelled(); trace.push({ at: Date.now(), stage: 'cancelling', state: final });
      if (final.completion !== undefined || item.unknown && final.preparation.phase === 'held') break; await pause(100);
    }
    if (item.unknown) {
      assert.equal(final.completion, undefined); assert.equal((await owner.resources()).charges[0].result, 'pending');
      const resolution = await owner.resolve('applied'); assert.equal(resolution.disposition, 'cancelled'); final = await owner.snapshot();
      await writeFile(join(path, 'resolution.json'), JSON.stringify({ receipt: resolution, audit: await owner.audit() }));
    }
    assert.equal(final.completion.outcome, 'cancelled'); assert.equal(final.preparation.deadline, accepted.deadline); assert.equal(final.preparation.cancelRequestedAt ?? final.completion.at, requested.cancelRequestedAt);
    assert.equal(await owner.httpCreated(), false); assert.equal((await owner.resources()).charges[0].result, 'absent');
    const application = await snapshot(); assert.equal(values(application.effects), item.effects); assert.equal(values(application.calls), item.effects);
    if (item.checkpoint !== 'ready') assert.equal(final.preparation.sequence.steps.some((step) => step.id === 'seed'), false);
    const ids = new Set(final.preparation.sequence.steps.flatMap((step) => step.attempts.map((attempt) => attempt.execution?.container).filter(Boolean)));
    await pause(100); assert.equal(eventError, undefined); const events = Buffer.concat(chunks).toString();
    const starts = events.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.Action === 'start' && ids.has(event.Actor.ID)); assert.equal(starts.length, item.starts);
    assert.ok([...ids].every((id) => starts.filter((event) => event.Actor.ID === id).length <= 1));
    await writeFile(join(path, 'events.jsonl'), events); await writeFile(join(path, 'trace.json'), JSON.stringify(trace));
    await writeFile(join(path, 'application.json'), JSON.stringify(application)); await writeFile(join(path, 'final.json'), JSON.stringify({ operation: final, status: await owner.status(), resources: await owner.resources() }));
    assert.equal(JSON.stringify(final).includes(privateValue), false); assert.equal(JSON.stringify(trace).includes(privateValue), false);
    for (const step of final.preparation.sequence.steps) for (const attempt of step.attempts) {
      const barrier = migrationAttemptBarrier(attempt); assert.ok(barrier); assert.equal((await api.request('DELETE', `/containers/${barrier}?v=true`)).status, 204);
    }
    await journal.close(); reports.push({ name: item.name, passed: true, effects: item.effects, nativeStarts: starts.length, originalDeadline: true, httpChildCreated: false, checkpoint: item.kill ? 'after-cancel-intent' : null }); console.log(JSON.stringify(reports.at(-1)));
  }
  observer.kill('SIGTERM'); await observerClosed; observer = undefined; assert.equal(eventError, undefined);
  assert.equal((await api.request('DELETE', `/services/${service}`)).status, 200); service = undefined;
  const engine = (await api.request('GET', '/version')).value;
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, reports, app, image, engine: engine.Version, api: engine.ApiVersion, node: process.version,
    scope: 'indexed preparation cancellation with native Docker jobs and app-owned counters; fixture registration/build ports; no public pipeline or HTTP continuity claim' }, null, 2));
} catch (error) {
  if (observer) { observer.kill('SIGTERM'); await observerClosed; }
  await writeFile(join(directory, 'failure.events.jsonl'), Buffer.concat(chunks));
  await writeFile(join(directory, 'failure.json'), JSON.stringify({ error: String(error), app, service, reports }, null, 2));
  console.error(`Preserved failed cancellation lab at ${directory}; inspect exact job identities and fixture service ${service ?? 'none'} before cleanup.`); throw error;
}
