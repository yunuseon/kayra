import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseMigrationSequencePlan } from '../../../cli/src/contracts/migration-sequence.ts';
import { parseJobPlan } from '../../../cli/src/contracts/one-shot-job.ts';
import { migrationSequence } from '../../../cli/src/server/deployment/migration-sequence.ts';
import { openArtifactStore } from '../../../cli/src/server/deployment/artifact-store.ts';
import { openJournal } from '../../../cli/src/server/deployment/journal.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { oneShotJob } from '../../../cli/src/server/runtime/one-shot-job.ts';
import { serverCode, migrationCommand, probeCommand } from './migration-fixture.mjs';
import { indexedMigrationOwner } from './indexed-migration-owner.mjs';

const [mode, directory, checkpoint] = process.argv.slice(2); assert.ok(directory);
const indexed = mode === 'indexed-run' || mode === 'indexed-child' || mode === 'host-run';
const api = dockerApi(); const native = oneShotJob(api); const run = promisify(execFile); const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const privateValue = 'synthetic-sequence-private-value';
const ports = async (path, source, killAt) => ({ ...await openArtifactStore(join(path, 'artifacts')), now: Date.now,
  authorize: async (state, plan, job, effect) => {
    if (killAt === 'before-start' && effect === 'start' && job.scope.purpose === 'migration') process.kill(process.pid, 'SIGKILL');
    return state.phase === 'running' && plan.deployment === source.deployment && job.scope.run === source.scope.run && job.scope.app === source.scope.app;
  },
  materialize: async (job) => Object.fromEntries(Object.entries(job.environment).map(([key, binding]) => [key, binding.kind === 'literal' ? binding.value : privateValue])),
  native: { ...native, start: async (...args) => { const result = await native.start(...args); if (killAt === 'after-start') { assert.equal(result, 'acknowledged'); process.kill(process.pid, 'SIGKILL'); } return result; } },
});
const openOwner = async (path, source, killAt, initialize, hostFault) => {
  const phasePorts = await ports(path, source, killAt);
  if (indexed) return indexedMigrationOwner(path, source, phasePorts, killAt, initialize, hostFault);
  const journal = await openJournal(path, initialize ? 'initialize' : 'existing');
  const view = { read: journal.read, write: async (value) => { await journal.write(value); if (killAt === 'after-advance' && value.position === 1) process.kill(process.pid, 'SIGKILL'); } };
  return { journal, owner: migrationSequence(view, phasePorts) };
};
if (mode === 'child' || mode === 'indexed-child') {
  const source = JSON.parse(await readFile(join(directory, 'source.json'), 'utf8'));
  const { owner } = await openOwner(directory, source, checkpoint, false);
  while (true) { const value = await owner.tick(); assert.equal(value.phase, 'running'); await pause(100); }
}
assert.ok(mode === 'run' || mode === 'indexed-run' || mode === 'host-run'); await mkdir(directory, { mode: 0o700 }); const app = 'migration-lab-' + randomUUID().slice(0, 8);
const host = JSON.parse(await readFile('/var/lib/kayra/swarm/authority.json', 'utf8'));
const deployer = (await run('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=platform', '--filter', 'label=com.docker.compose.service=deployer',
  '--filter', 'label=com.docker.compose.oneoff=False'])).stdout.trim(); assert.match(deployer, /^[0-9a-f]{12,64}$/);
const sourceImage = JSON.parse((await run('docker', ['inspect', deployer])).stdout)[0].Image; const tag = `localhost:5000/${app}/web:fixture`;
await run('docker', ['image', 'tag', sourceImage, tag]); await run('docker', ['image', 'push', tag], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
const image = JSON.parse((await run('docker', ['image', 'inspect', tag])).stdout)[0].RepoDigests.find((value) => value.startsWith(`localhost:5000/${app}/web@sha256:`)); assert.ok(image);
const serviceName = app + '-state'; let serviceId; let activeObserver; const reports = [];
try {
  const created = await api.request('POST', '/services/create', { Name: serviceName, Labels: { 'com.kayra.lab': app, 'traefik.enable': 'false' },
    TaskTemplate: { ContainerSpec: { Image: image, Command: ['node'], Args: ['--input-type=commonjs', '-e', serverCode],
      Healthcheck: { Test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], Interval: 2e9, Timeout: 1e9, Retries: 3 }, StopGracePeriod: 30e9 },
      Resources: { Limits: { MemoryBytes: 128 * 1024 * 1024, NanoCPUs: 250_000_000 } }, RestartPolicy: { Condition: 'none' },
      Placement: { Constraints: [`node.id==${host.node}`] }, Networks: [{ Target: host.network.id }] }, Mode: { Replicated: { Replicas: 1 } }, EndpointSpec: { Mode: 'vip' } });
  assert.equal(created.status, 201); serviceId = created.value.ID; assert.ok(serviceId);
  let stateContainer; const readyDeadline = Date.now() + 90000;
  while (Date.now() < readyDeadline) {
    const tasks = await api.request('GET', '/tasks?filters=' + encodeURIComponent(JSON.stringify({ service: [serviceId] })));
    const task = tasks.value.find((value) => value.DesiredState === 'running' && value.Status.State === 'running');
    if (task?.Status.ContainerStatus?.ContainerID) {
      const inspect = await api.request('GET', `/containers/${task.Status.ContainerStatus.ContainerID}/json`);
      if (inspect.value.State.Health?.Status === 'healthy') { stateContainer = task.Status.ContainerStatus.ContainerID; break; }
    } await pause(250);
  } assert.ok(stateContainer, 'application-owned state fixture never became healthy');
  const scenarios = mode === 'host-run' ? [
    { name: 'host-unavailable-before-create', safe: true, steps: ['schema'], hostFault: 'before-create', held: 'runtime', effects: 0, calls: 0, nativeStarts: 0 },
    { name: 'host-unavailable-before-start', safe: true, steps: ['schema'], hostFault: 'after-create', held: 'runtime', effects: 0, calls: 0, nativeStarts: 0 },
    { name: 'owned-fencing-with-host-unavailable', safe: true, steps: ['schema'], hostFault: 'after-start', effects: 1, calls: 1, nativeStarts: 1 },
  ] : [
    { name: 'ordered', safe: true, steps: ['schema', 'seed'], effects: 2, calls: 2 },
    { name: 'safe-effect-before-failure', safe: true, first: true, steps: ['schema'], effects: 1, calls: 2 },
    { name: 'unsafe-effect-before-failure', safe: false, always: true, steps: ['schema'], effects: 1, calls: 1 },
    { name: 'unknown-probe', safe: false, always: true, unknown: true, steps: ['schema'], held: 'probe-unknown', effects: 1, calls: 1 },
    { name: 'not-applied', safe: false, before: true, steps: ['schema'], held: 'not-applied', effects: 0, calls: 0 },
    { name: 'kill-before-start', safe: false, steps: ['schema'], kill: 'before-start', held: 'not-applied', effects: 0, calls: 0, nativeStarts: 1 },
    { name: 'kill-after-start', safe: false, always: true, steps: ['schema'], kill: 'after-start', effects: 1, calls: 1 },
    { name: 'kill-after-advance', safe: true, steps: ['schema', 'seed'], kill: 'after-advance', effects: 2, calls: 2 },
  ];
  for (const item of scenarios) {
    const path = join(directory, item.name); await mkdir(path, { mode: 0o700 }); const startedAt = Date.now();
    const chunks = []; let eventBytes = 0; let eventError;
    const observer = spawn('docker', ['events', '--since', String(Math.floor(startedAt / 1000)), '--filter', 'type=container',
      '--filter', 'label=com.kayra.app=' + app, '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
    activeObserver = observer; const observerClosed = new Promise((resolve) => observer.once('close', resolve));
    observer.on('error', () => { eventError = 'event observer unavailable'; });
    observer.stdout.on('data', (chunk) => { eventBytes += chunk.length; if (eventBytes > 4 * 1024 * 1024) { eventError = 'event observer overflow'; observer.kill('SIGTERM'); } else chunks.push(chunk); });
    observer.stderr.on('data', () => { eventError = 'event observer failed'; });
    const parsed = parseMigrationSequencePlan({ version: 1, deployment: 'd'.repeat(64), scope: { app, incarnation: randomUUID(), run: randomUUID() },
      policy: { schedulingSeconds: 90, cleanupSeconds: 30, maximumAttempts: 8, timeoutCeilingSeconds: 90 },
      steps: item.steps.map((id) => ({ definition: { id, service: 'web', command: migrationCommand, timeout_seconds: 30,
        recovery: item.safe ? { kind: 'replay-safe' } : { kind: 'status-probe', command: probeCommand, timeout_seconds: 15 } },
        template: { version: 1, image, entrypoint: ['node'], environment: {
          DB_HOST: { kind: 'literal', value: serviceName }, REPLAY_SAFE: { kind: 'literal', value: item.safe ? '1' : '0' },
          FAIL_FIRST: { kind: 'literal', value: item.first ? '1' : '0' }, FAIL_ALWAYS: { kind: 'literal', value: item.always ? '1' : '0' },
          FAIL_BEFORE: { kind: 'literal', value: item.before ? '1' : '0' }, PROBE_MODE: { kind: 'literal', value: item.unknown ? 'unknown' : 'truth' },
          TOKEN: { kind: 'secret', key: 'TOKEN' } }, resources: { memoryBytes: 128 * 1024 * 1024, nanoCpus: 250_000_000 }, networks: [host.network.id], stopGraceSeconds: 30 } })) });
    assert.ok(parsed.ok, parsed.error); const source = parsed.value; await writeFile(join(path, 'source.json'), JSON.stringify(source));
    let { journal, owner } = await openOwner(path, source, undefined, true, item.hostFault); const accepted = await owner.prepare(source, startedAt + 180000);
    if (item.kill) {
      await journal.close(); const killed = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), indexed ? 'indexed-child' : 'child', path, item.kill], { stdio: ['ignore', 'ignore', 'pipe'] });
        const errors = []; child.stderr.on('data', (chunk) => errors.push(chunk)); child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code, signal, stderr: Buffer.concat(errors).toString() }));
      }); assert.equal(killed.signal, 'SIGKILL', JSON.stringify(killed)); ({ journal, owner } = await openOwner(path, source, undefined, false));
    }
    const trace = []; let final;
    while (Date.now() < accepted.deadline + 30000) { const value = await owner.tick(); trace.push({ at: Date.now(), value }); if (value.phase !== 'running') { final = value; break; } await pause(100); }
    assert.ok(final); assert.equal(final.phase, item.held ? 'held' : 'succeeded'); assert.equal(final.reason, item.held ?? null); assert.equal(final.deadline, accepted.deadline);
    const snapshot = JSON.parse((await run('docker', ['exec', stateContainer, 'node', '-e', "fetch('http://127.0.0.1:8080/snapshot').then(r=>r.text()).then(s=>process.stdout.write(s))"], { timeout: 10000 })).stdout);
    const values = (map) => Object.entries(map).filter(([key]) => key.startsWith(source.scope.run + ':')).reduce((sum, [, value]) => sum + value, 0);
    assert.equal(values(snapshot.effects), item.effects); assert.equal(values(snapshot.calls), item.calls);
    observer.kill('SIGTERM'); await observerClosed; activeObserver = undefined; assert.equal(eventError, undefined);
    const events = Buffer.concat(chunks).toString();
    await writeFile(join(path, 'events.jsonl'), events); await writeFile(join(path, 'trace.json'), JSON.stringify(trace)); await writeFile(join(path, 'application.json'), JSON.stringify(snapshot));
    const ids = new Set(final.steps.flatMap((step) => step.attempts.map((attempt) => attempt.execution.container)));
    const starts = events.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.Action === 'start' && ids.has(event.Actor.ID));
    assert.equal(starts.length, item.nativeStarts ?? ids.size); assert.ok([...ids].every((id) => starts.filter((event) => event.Actor.ID === id).length <= 1));
    if (item.kill === 'before-start') assert.ok(starts.every((event) => event.Actor.ID !== final.steps[0].attempts[0].execution.container));
    assert.ok(!JSON.stringify(final).includes(privateValue)); assert.ok(!JSON.stringify(trace).includes(privateValue));
    for (const step of final.steps) for (const attempt of step.attempts) {
      if (item.hostFault && item.held) assert.equal(attempt.execution.phase, 'held'); else assert.equal(attempt.execution.phase, 'complete');
      const job = parseJobPlan(JSON.parse(await (await openArtifactStore(join(path, 'artifacts'))).read(attempt.artifact))); assert.ok(job.ok);
      if (item.hostFault && item.held) {
        const before = await native.observe(job.value); assert.ok(before.status === 'absent' || before.status === 'owned' && before.state === 'created' && !before.barrier);
        if (item.hostFault === 'before-create') assert.equal(before.status, 'absent');
        if (item.hostFault === 'after-create') assert.equal(before.status, 'owned');
        assert.equal(await native.fence(job.value, before.status === 'owned' ? before.id : null, Date.now() + 30000), 'acknowledged');
      }
      const barrier = await native.observe(job.value); assert.equal(barrier.status, 'owned'); assert.equal(barrier.barrier, true);
      assert.equal((await api.request('DELETE', `/containers/${barrier.id}?force=true&v=true`)).status, 204);
    }
    await journal.close(); reports.push({ name: item.name, phase: final.phase, reason: final.reason, steps: final.steps.map((step) => ({ id: step.id, attempts: step.attempts.length })),
      effects: item.effects, calls: item.calls, nativeStarts: starts.length, originalDeadline: true, privateValuesPersisted: false, checkpoint: item.kill ?? null, hostFault: item.hostFault ?? null }); console.log(JSON.stringify(reports.at(-1)));
  }
  assert.equal((await api.request('DELETE', `/services/${serviceId}`)).status, 200); serviceId = undefined;
  const version = await api.request('GET', '/version'); await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, reports, app, image, engine: version.value.Version,
    api: version.value.ApiVersion, node: process.version, fixtureServiceRemoved: true,
    scope: mode === 'host-run' ? 'injected normalized-host failures with real jobs and indexed admission; no actual host reconfiguration or public-deployer claim' : indexed ? 'indexed lifecycle, durable admission and native migration effects with fixture registration/build ports; HTTP handoff only' : 'isolated phase owner with application-owned effect/dedup fixture; no real-deployer admission or migration rollout integration' }, null, 2));
} catch (error) {
  if (activeObserver) activeObserver.kill('SIGTERM');
  await writeFile(join(directory, 'failure.json'), JSON.stringify({ error: String(error), serviceId, app, image, reports }, null, 2));
  console.error(JSON.stringify({ error: String(error), directory, serviceId, cleanup: serviceId ? `sudo docker service rm ${serviceId}` : null })); process.exitCode = 1;
}
