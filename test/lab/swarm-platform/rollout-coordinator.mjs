// Indexed component: fixture registration/build ports, real jobs, Swarm services and TLS routing.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { spawn, fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseRolloutPlan } from '../../../cli/src/contracts/rollout-plan.ts';
import { parseJobPlan } from '../../../cli/src/contracts/one-shot-job.ts';
import { createLifecycleAppIndex, openLifecycleAppIndex } from '../../../cli/src/server/deployment/lifecycle-app-index.ts';
import { openArtifactStore } from '../../../cli/src/server/deployment/artifact-store.ts';
import { rolloutExecution } from '../../../cli/src/server/deployment/rollout-execution.ts';
import { startRolloutController } from '../../../cli/src/server/composition/rollout-controller.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { oneShotJob } from '../../../cli/src/server/runtime/one-shot-job.ts';
import { swarmService } from '../../../cli/src/server/runtime/swarm-service.ts';
import { observeSwarmHost } from '../../../cli/src/server/runtime/swarm-host.ts';
import { routedReadiness } from '../../../cli/src/server/platform/routed-readiness.ts';
import { swarmRouting } from '../../../cli/src/server/platform/swarm-routing.ts';
import { serverCode, migrationCommand, probeCommand, healthCommand } from './migration-fixture.mjs';

const [mode, directory] = process.argv.slice(2); assert.ok(directory);
const api = dockerApi(); const run = promisify(execFile); const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const privateValue = 'synthetic-complete-rollout-private-value';
const portsFor = async () => ({ ...await openArtifactStore(join(directory, 'artifacts')), now: Date.now, jobs: oneShotJob(api), native: swarmService(api),
  observeHost: (host) => observeSwarmHost(host, api), routing: swarmRouting,
  materialize: async (plan) => Object.fromEntries(Object.entries(plan.services.web.environment).map(([key, binding]) => [key, binding.kind === 'literal' ? binding.value : privateValue])),
  readiness: routedReadiness({ address: '127.0.0.1', ca: await readFile('/var/lib/kayra/swarm/lab-ca.pem', 'utf8') }),
});
if (mode === 'writer') {
  setInterval(() => {}, 1000);
  const context = JSON.parse(await readFile(join(directory, 'context.json'), 'utf8')); const index = await openLifecycleAppIndex(join(directory, 'index')); const ports = await portsFor();
  const execution = rolloutExecution(index, { ...ports, native: { ...ports.native, apply: async (...args) => {
    const result = await ports.native.apply(...args); assert.equal(result, 'acknowledged');
    await new Promise((resolve, reject) => process.send({ checkpoint: 'native-acknowledged' }, (error) => error ? reject(error) : resolve()));
    return new Promise(() => {});
  } } });
  for (;;) { await execution.tick(context.app, context.request); await pause(100); }
}
assert.equal(mode, 'run'); await mkdir(directory, { mode: 0o700 }); const app = 'rollout-component-' + randomUUID().slice(0, 8);
let index; let controller; let serviceId; let stateId; let observer; const reports = []; const trace = [];
try {
  const host = JSON.parse(await readFile('/var/lib/kayra/swarm/authority.json', 'utf8'));
  const template = JSON.parse(await readFile(new URL('../../../ci/tests/swarm-http/native-plan.json', import.meta.url), 'utf8'));
  const fixtureCode = await readFile(new URL('./http-fixture/web/fixture.mjs', import.meta.url), 'utf8');
  // Keep the fixture's JS template interpolation out of Compose command interpolation.
  const fixtureCommand = "await import('data:text/javascript;base64," + Buffer.from(fixtureCode).toString('base64') + "')";
  const deployer = (await run('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=platform', '--filter', 'label=com.docker.compose.service=deployer', '--filter', 'label=com.docker.compose.oneoff=False'])).stdout.trim();
  assert.match(deployer, /^[0-9a-f]{12,64}$/);
  const sourceImage = JSON.parse((await run('docker', ['inspect', deployer])).stdout)[0].Image; const tag = `localhost:5000/${app}/web:fixture`;
  await run('docker', ['image', 'tag', sourceImage, tag]); await run('docker', ['image', 'push', tag], { timeout: 120000 });
  const image = JSON.parse((await run('docker', ['image', 'inspect', tag])).stdout)[0].RepoDigests.find((value) => value.startsWith(`localhost:5000/${app}/web@sha256:`)); assert.ok(image);
  const stateName = app + '-state';
  const created = await api.request('POST', '/services/create', { Name: stateName, Labels: { 'com.kayra.lab': app, 'traefik.enable': 'false' },
    TaskTemplate: { ContainerSpec: { Image: image, Command: ['node'], Args: ['--input-type=commonjs', '-e', serverCode], StopGracePeriod: 30e9 },
      Resources: { Limits: { MemoryBytes: 128 * 1024 * 1024, NanoCPUs: 250_000_000 } }, RestartPolicy: { Condition: 'none' },
      Placement: { Constraints: [`node.id==${host.node}`] }, Networks: [{ Target: host.network.id }] }, Mode: { Replicated: { Replicas: 1 } }, EndpointSpec: { Mode: 'vip' } });
  assert.equal(created.status, 201); stateId = created.value.ID; assert.ok(stateId);
  const wait = async (call, label, deadline = Date.now() + 90_000) => {
    while (Date.now() < deadline) { const result = await call(); if (result) return result; await pause(250); } throw new Error('timed out: ' + label);
  };
  const stateContainer = await wait(async () => {
    const tasks = await api.request('GET', '/tasks?filters=' + encodeURIComponent(JSON.stringify({ service: [stateId] })));
    const container = tasks.value.find((task) => task.DesiredState === 'running' && task.Status.State === 'running')?.Status.ContainerStatus.ContainerID;
    if (!container) return false;
    const result = await run('docker', ['exec', container, ...healthCommand]).catch(() => undefined);
    return result ? container : false;
  }, 'application state fixture');
  const chunks = []; let eventBytes = 0; let eventError;
  observer = spawn('docker', ['events', '--since', String(Math.floor(Date.now() / 1000)), '--filter', 'type=container', '--filter', 'label=com.kayra.app=' + app, '--format', '{{json .}}']);
  const observerClosed = new Promise((resolve) => observer.once('close', resolve)); observer.on('error', () => { eventError = 'event observer unavailable'; });
  observer.stdout.on('data', (chunk) => { eventBytes += chunk.length; if (eventBytes > 4 * 1024 * 1024) { eventError = 'event overflow'; observer.kill('SIGTERM'); } else chunks.push(chunk); });
  observer.stderr.on('data', () => { eventError = 'event observer failed'; });
  index = await createLifecycleAppIndex(join(directory, 'index'), (identity) => Promise.resolve({ ...identity, status: 'applied' })); await index.prepareApp(app);
  const generation = randomUUID(); const ticket = await index.reserveRegistration(app, generation, 'swarm'); await index.submitRegistration(app, ticket, generation); await index.reconcileRegistration(app, ticket, generation);
  const ports = await portsFor(); const builds = { ...ports, images: () => [image], prepare: async () => JSON.stringify({ fixtureImage: image }) };
  const plans = { ...ports, preview: async (registration, _runtime, commit, artifact) => {
    const release = commit[0].toUpperCase(); const unsafe = release === 'D';
    const environment = Object.fromEntries(Object.entries({ RELEASE: release, DB_HOST: stateName, REPLAY_SAFE: unsafe ? '0' : '1', FAIL_ALWAYS: unsafe ? '1' : '0', PROBE_MODE: unsafe ? 'unknown' : 'truth',
      FAIL_AFTER_READY_MS: release === 'C' ? '8000' : '0' }).map(([key, value]) => [key, { kind: 'literal', value }]));
    const workload = { ...template, app, registration, host, commit, artifact, routes: template.routes.map((route) => ({ ...route, host: `${app}.lab.test`, check: '/version' })),
      services: { web: { ...template.services.web, image, command: ['--input-type=module', '-e', fixtureCommand], entrypoint: ['node'], environment: { ...environment, TOKEN: { kind: 'secret', key: 'TOKEN' } },
        resources: { ...template.services.web.resources, memoryBytes: 128 * 1024 * 1024, nanoCpus: 250_000_000 },
        health: { command: healthCommand, intervalSeconds: 1, timeoutSeconds: 1, startPeriodSeconds: 1, retries: 3 } } } };
    const plan = parseRolloutPlan({ version: 2, runtime: 'swarm', workload, policy: { version: 1, migrationTimeoutCeilingSeconds: 90, schedulingSeconds: 90, cleanupSeconds: 30, maximumAttempts: 8 },
      rollout: { ...workload.rollout, migrations: [{ id: 'schema', service: 'web', command: migrationCommand, timeout_seconds: 30,
        recovery: unsafe ? { kind: 'status-probe', command: probeCommand, timeout_seconds: 15 } : { kind: 'replay-safe' } }] } });
    assert.ok(plan.ok, plan.error); return plan.value;
  } };
  const start = async (letter) => { const commit = letter.repeat(40); await index.prepareBuild(app, commit, builds); return index.prepareRollout(app, randomUUID(), commit, plans); };
  const drive = async (operation, expected) => {
    const execution = rolloutExecution(index, ports);
    return wait(async () => { const phase = await execution.tick(app, operation.preparation.run); trace.push({ at: Date.now(), request: operation.preparation.run, phase });
      if (['held', 'succeeded', 'failed'].includes(phase)) { assert.equal(phase, expected); return index.rolloutOperation(app, operation.preparation.run); } return false;
    }, expected + ' complete rollout', operation.preparation.deadline + 1000);
  };
  const a = await start('a'); await drive(a, 'succeeded'); const activeA = await index.httpOperation(app, a.preparation.run); serviceId = activeA.verified.native.id;
  assert.equal(activeA.verified.deployment, a.preparation.plan); reports.push({ name: 'initial-complete-rollout', passed: true });
  const b = await start('b'); await writeFile(join(directory, 'context.json'), JSON.stringify({ app, request: b.preparation.run })); await index.close(); index = undefined;
  const child = fork(fileURLToPath(import.meta.url), ['writer', directory], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }); const exited = once(child, 'exit');
  try { const [message] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(90_000) }), exited.then(() => { throw new Error('writer exited before acknowledgement'); })]);
    assert.equal(message.checkpoint, 'native-acknowledged'); child.kill('SIGKILL'); await exited;
  } finally { child.kill('SIGKILL'); await exited; }
  index = await openLifecycleAppIndex(join(directory, 'index')); const interrupted = await index.httpOperation(app, b.preparation.run); assert.equal(interrupted.phase, 'applying');
  assert.deepEqual(await index.pendingHttpOperations(), []); assert.deepEqual(await index.pendingRolloutOperations(), [{ app, request: b.preparation.run }]);
  let replayedHttpWrites = 0; let replayedJobStarts = 0;
  controller = startRolloutController(index, { ...ports, native: { ...ports.native, apply: (...args) => { replayedHttpWrites++; return ports.native.apply(...args); } },
    jobs: { ...ports.jobs, start: (...args) => { replayedJobStarts++; return ports.jobs.start(...args); } } });
  await wait(async () => (await index.httpOperation(app, b.preparation.run)).phase === 'succeeded', 'automatic complete rollout recovery'); await controller.close(); controller = undefined;
  assert.equal(replayedHttpWrites, 0); assert.equal(replayedJobStarts, 0); assert.equal((await index.httpOperation(app, b.preparation.run)).deadline, interrupted.deadline);
  reports.push({ name: 'restart-after-http-acknowledgement', passed: true, replayedHttpWrites, replayedJobStarts });
  const c = await start('c'); const recoveryStarted = Date.now(); await drive(c, 'failed'); await rolloutExecution(index, ports).tick(app, c.preparation.run);
  const failed = await index.httpOperation(app, c.preparation.run); assert.equal(failed.recovery.kind, 'automatic-rollback'); assert.equal(failed.recovery.verified.deployment, b.preparation.plan);
  assert.equal((await index.resourceSnapshot()).charges[0].result, 'previous'); const status = await index.deploymentStatus(app);
  assert.equal(status.requested.plan, c.preparation.plan); assert.equal(status.desired.plan, b.preparation.plan); assert.equal(status.verifiedActive.plan, b.preparation.plan);
  reports.push({ name: 'automatic-rollback-preserves-complete-release', passed: true, recoveryMs: Date.now() - recoveryStarted, uninterrupted: false });
  const d = await start('d'); await drive(d, 'held'); assert.equal(await index.httpOperation(app, d.preparation.run), undefined);
  const held = await index.deploymentStatus(app); assert.equal(held.requiredAction, 'inspect-and-resolve'); assert.equal(held.preparation.phase, 'held'); assert.equal(held.verifiedActive.plan, b.preparation.plan);
  assert.equal((await index.resourceSnapshot()).charges[0].result, 'pending'); reports.push({ name: 'unknown-migration-never-exposes-http-candidate', passed: true });
  const operations = await Promise.all([a, b, c, d].map((item) => index.rolloutOperation(app, item.preparation.run)));
  const snapshot = JSON.parse((await run('docker', ['exec', stateContainer, 'node', '-e', "fetch('http://127.0.0.1:8080/snapshot').then(r=>r.text()).then(s=>process.stdout.write(s))"])).stdout);
  for (const operation of operations) { const key = operation.preparation.run + ':schema'; assert.equal(snapshot.effects[key], 1); assert.equal(snapshot.calls[key], 1); }
  observer.kill('SIGTERM'); await observerClosed; observer = undefined; assert.equal(eventError, undefined); const events = Buffer.concat(chunks).toString();
  const attempts = operations.flatMap((item) => item.preparation.sequence.steps.flatMap((step) => step.attempts)); assert.equal(attempts.length, 5);
  const ids = attempts.map((attempt) => attempt.execution.container); const starts = events.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.Action === 'start' && ids.includes(event.Actor.ID));
  assert.equal(starts.length, 5); assert.ok(ids.every((id) => starts.filter((event) => event.Actor.ID === id).length === 1));
  await writeFile(join(directory, 'events.jsonl'), events); await writeFile(join(directory, 'trace.json'), JSON.stringify(trace)); await writeFile(join(directory, 'application.json'), JSON.stringify(snapshot));
  await writeFile(join(directory, 'operations.json'), JSON.stringify(operations)); assert.ok(!JSON.stringify(operations).includes(privateValue));
  for (const attempt of attempts) { const job = parseJobPlan(JSON.parse(await ports.read(attempt.artifact))); assert.ok(job.ok); const barrier = await ports.jobs.observe(job.value);
    assert.equal(barrier.status, 'owned'); assert.equal(barrier.barrier, true); assert.equal((await api.request('DELETE', `/containers/${barrier.id}?force=true&v=true`)).status, 204); }
  assert.equal((await api.request('DELETE', `/services/${serviceId}`)).status, 200); serviceId = undefined;
  assert.equal((await api.request('DELETE', `/services/${stateId}`)).status, 200); stateId = undefined;
  const version = await api.request('GET', '/version'); await index.close(); index = undefined;
  const result = { passed: true, reports, app, image, engine: version.value.Version, api: version.value.ApiVersion, node: process.version, nativeJobStarts: starts.length,
    scope: 'indexed lifecycle through real jobs, Swarm service operations and TLS readiness; fixture registration/build ports; no public deployer, DB-volume safety or continuity claim' };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  if (observer) observer.kill('SIGTERM'); if (controller) await controller.close();
  if (index) {
    try { const registration = await index.verifiedRegistration(app); const observed = await swarmService(api).observe({ app, service: 'web', incarnation: registration.incarnation });
      if (observed.status === 'owned') serviceId = observed.id;
    } catch { /* Preserve the original failure if ownership cannot be observed. */ }
    await index.close();
  }
  const failure = { error: String(error), directory, app, serviceId, stateId, reports, cleanup: [serviceId, stateId].filter(Boolean).map((id) => `sudo docker service rm ${id}`) };
  await writeFile(join(directory, 'failure.json'), JSON.stringify(failure, null, 2)); console.error(JSON.stringify(failure)); process.exitCode = 1;
}
