// Component integration only: trusted fixture build inputs, real journal/runtime/TLS.
import { strict as assert } from 'node:assert';
import { execFileSync, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseApplicationPlan } from '../../../cli/src/contracts/application-plan.ts';
import { openArtifactStore } from '../../../cli/src/server/deployment/artifact-store.ts';
import { httpExecution } from '../../../cli/src/server/deployment/http-execution.ts';
import { startHttpController } from '../../../cli/src/server/composition/http-controller.ts';
import { createLifecycleAppIndex, openLifecycleAppIndex } from '../../../cli/src/server/deployment/lifecycle-app-index.ts';
import { routedReadiness } from '../../../cli/src/server/platform/routed-readiness.ts';
import { swarmRouting } from '../../../cli/src/server/platform/swarm-routing.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { observeSwarmHost } from '../../../cli/src/server/runtime/swarm-host.ts';
import { swarmService } from '../../../cli/src/server/runtime/swarm-service.ts';

const api = dockerApi();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const privateValue = 'synthetic-coordinator-input';
const portsFor = async (root) => {
  const artifacts = await openArtifactStore(join(root, 'artifacts'));
  return {
    ...artifacts, now: Date.now, observeHost: (host) => observeSwarmHost(host, api), native: swarmService(api), routing: swarmRouting,
    materialize: (plan) => Promise.resolve({ RELEASE: plan.services.web.environment.RELEASE.value, TOKEN: privateValue }),
    readiness: routedReadiness({ address: '127.0.0.1', ca: await readFile('/var/lib/kayra/swarm/lab-ca.pem', 'utf8') }),
  };
};
if (process.argv[2] === 'writer') {
  setInterval(() => {}, 1000);
  const root = process.argv[3]; const app = process.argv[4]; const request = process.argv[5];
  const index = await openLifecycleAppIndex(join(root, 'index'));
  const ports = await portsFor(root);
  const execution = httpExecution({ ...index, markHttpDispatched: async () => {
    await new Promise((resolve, reject) => process.send({ checkpoint: 'native-acknowledged' }, (error) => error ? reject(error) : resolve()));
    return new Promise(() => {});
  } }, ports);
  for (;;) { await execution.tick(app, request); await pause(100); }
} else {
  const app = 'coordinator-lab-' + randomUUID().replaceAll('-', '');
  const root = await mkdtemp('/var/lib/kayra-http-coordinator-');
  let index; let serviceId; let controller;
  try {
    const host = JSON.parse(await readFile('/var/lib/kayra/swarm/authority.json', 'utf8'));
    const template = JSON.parse(await readFile(new URL('../../../ci/tests/swarm-http/native-plan.json', import.meta.url), 'utf8'));
    const sample = execFileSync('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=sample'], { encoding: 'utf8' }).trim();
    const container = JSON.parse(execFileSync('docker', ['inspect', sample], { encoding: 'utf8' }))[0];
    const tag = `localhost:5000/${app}/web:fixture`;
    execFileSync('docker', ['image', 'tag', container.Image, tag]);
    execFileSync('docker', ['image', 'push', tag], { stdio: ['ignore', 'pipe', 'pipe'] });
    const imageInfo = JSON.parse(execFileSync('docker', ['image', 'inspect', tag], { encoding: 'utf8' }))[0];
    const image = imageInfo.RepoDigests.find((ref) => ref.startsWith(`localhost:5000/${app}/web@sha256:`)); assert.ok(image);
    index = await createLifecycleAppIndex(join(root, 'index'), (identity) => Promise.resolve({ ...identity, status: 'applied' }));
    await index.prepareApp(app);
    const generation = randomUUID();
    const ticket = await index.reserveRegistration(app, generation, 'swarm');
    await index.submitRegistration(app, ticket, generation); await index.reconcileRegistration(app, ticket, generation);
    const ports = await portsFor(root);
    const builds = { ...ports, images: () => [image], prepare: () => Promise.resolve(JSON.stringify({ fixtureImage: image })) };
    const plans = { ...ports, preview: async (registration, _runtime, commit, artifact) => {
      const plan = parseApplicationPlan({ ...template, app, registration, host, commit, artifact,
        routes: template.routes.map((route) => ({ ...route, host: `${app}.lab.test` })),
        services: { web: { ...template.services.web, image,
          command: commit[0] === 'c' ? ['sh', '-c', 'httpd -p 8080 -h /www; sleep 8; killall httpd; exit 1'] : null,
          environment: { RELEASE: { kind: 'literal', value: commit[0].toUpperCase() }, TOKEN: { kind: 'secret', key: 'TOKEN' } } } },
      });
      assert.ok(plan.ok, plan.error); return plan.value;
    } };
    const wait = async (action, label) => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) { const value = await action(); if (value) return value; await pause(500); }
      throw new Error('timed out: ' + label);
    };
    await index.prepareBuild(app, 'a'.repeat(40), builds);
    const a = await index.prepareHttpRollout(app, randomUUID(), 'a'.repeat(40), plans);
    const execution = httpExecution(index, ports);
    await wait(async () => (await execution.tick(app, a.request)) === 'succeeded', 'verified routed A');
    const activeA = await index.httpOperation(app, a.request); assert.equal(activeA.phase, 'succeeded');
    serviceId = activeA.verified.native.id;
    await index.prepareBuild(app, 'b'.repeat(40), builds);
    const b = await index.prepareHttpRollout(app, randomUUID(), 'b'.repeat(40), plans);
    assert.equal(b.previous.plan, a.plan);
    await index.close(); index = undefined;
    const child = fork(fileURLToPath(import.meta.url), ['writer', root, app, b.request], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const exited = once(child, 'exit');
    try {
      const [message] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(45_000) }), exited.then(() => { throw new Error('writer exited before acknowledgement'); })]);
      assert.equal(message.checkpoint, 'native-acknowledged');
      child.kill('SIGKILL'); await exited;
    } finally { child.kill('SIGKILL'); await exited; }
    index = await openLifecycleAppIndex(join(root, 'index'));
    const interrupted = await index.httpOperation(app, b.request);
    assert.equal(interrupted.phase, 'applying'); assert.equal(interrupted.deadline, b.deadline);
    let replayedWrites = 0;
    assert.deepEqual(await index.pendingHttpOperations(), [{ app, request: b.request }]);
    controller = startHttpController(index, { ...ports, native: { ...ports.native, apply: (...args) => { replayedWrites += 1; return ports.native.apply(...args); } } });
    await wait(async () => (await index.httpOperation(app, b.request)).phase === 'succeeded', 'automatically reconstructed routed B');
    await controller.close(); controller = undefined;
    const activeB = await index.httpOperation(app, b.request);
    assert.equal(activeB.verified.native.id, serviceId);
    assert.equal(activeB.deadline, b.deadline); assert.equal(replayedWrites, 0);
    assert.equal((await index.resourceSnapshot()).charges[0].result, 'target');
    assert.deepEqual(await index.pendingHttpOperations(), []);
    assert.equal(JSON.stringify(activeB).includes(privateValue), false);
    // C starts healthy, then exits inside Swarm's native monitoring window.
    await index.prepareBuild(app, 'c'.repeat(40), builds);
    const c = await index.prepareHttpRollout(app, randomUUID(), 'c'.repeat(40), plans);
    const recovery = httpExecution(index, ports);
    const failureStarted = Date.now();
    const recoveryTrace = [];
    await wait(async () => {
      const phase = await recovery.tick(app, c.request); recoveryTrace.push({ at: Date.now(), phase });
      assert.notEqual(phase, 'succeeded'); assert.notEqual(phase, 'held');
      return phase === 'failed';
    }, 'native rollback to B');
    await recovery.tick(app, c.request);
    const recoveredC = await index.httpOperation(app, c.request);
    assert.equal(recoveredC.recovery.kind, 'automatic-rollback');
    assert.equal(recoveredC.recovery.verified.plan, b.plan);
    const status = await index.deploymentStatus(app);
    assert.equal(status.requested.plan, c.plan); assert.equal(status.desired.plan, b.plan);
    assert.equal(status.verifiedActive.plan, b.plan); assert.equal(status.lastKnownGood.plan, b.plan);
    assert.equal(status.operation.phase, 'failed'); assert.equal(status.operation.recovery, 'automatic-rollback');
    assert.equal(status.runtimeObservation, 'not-observed');
    assert.equal((await index.resourceSnapshot()).charges[0].result, 'previous');
    const automaticRecoveryMs = Date.now() - failureStarted;
    // D's write is delayed before reaching Docker. A native version fence must
    // reject it before the coordinator can settle the unchanged healthy B.
    await index.prepareBuild(app, 'd'.repeat(40), builds);
    const d = await index.prepareHttpRollout(app, randomUUID(), 'd'.repeat(40), plans);
    let delayed;
    const uncertain = httpExecution(index, { ...ports, native: { ...ports.native, apply: (...args) => { delayed = args; return Promise.resolve('uncertain'); } } });
    assert.equal(await uncertain.tick(app, d.request), 'admitted');
    assert.equal(await uncertain.tick(app, d.request), 'applying');
    assert.equal(await uncertain.tick(app, d.request), 'write-uncertain');
    await index.beginHttpRecovery(app, d.ticket, 'runtime', Date.now());
    assert.equal(await recovery.tick(app, d.request), 'acknowledged');
    assert.notEqual(await ports.native.apply(...delayed), 'acknowledged');
    await wait(async () => (await recovery.tick(app, d.request)) === 'failed', 'fenced unchanged B');
    const recoveredD = await index.httpOperation(app, d.request);
    assert.equal(recoveredD.recovery.kind, 'previous-preserved');
    assert.equal(recoveredD.recovery.verified.plan, b.plan);
    await recovery.tick(app, d.request);
    assert.equal((await index.resourceSnapshot()).charges[0].result, 'previous');
    // Cancel after native dispatch, then lose the observer after restoration.
    await index.prepareBuild(app, 'e'.repeat(40), builds);
    const e = await index.prepareHttpRollout(app, randomUUID(), 'e'.repeat(40), plans);
    assert.equal(await recovery.tick(app, e.request), 'admitted');
    assert.equal((await index.resourceSnapshot()).charges[0].peak.cpu, 300);
    assert.equal(await recovery.tick(app, e.request), 'applying');
    assert.equal(await recovery.tick(app, e.request), 'verifying');
    const cancellation = await index.cancelHttpRollout(app, e.request, Date.now());
    assert.equal(cancellation.phase, 'recovering');
    await wait(async () => (await recovery.tick(app, e.request)) === 'acknowledged', 'native restoration acknowledgement');
    await index.close(); index = undefined;
    index = await openLifecycleAppIndex(join(root, 'index'));
    let cancellationReplayedWrites = 0;
    controller = startHttpController(index, { ...ports, native: { ...ports.native, apply: (...args) => { cancellationReplayedWrites += 1; return ports.native.apply(...args); } } });
    await wait(async () => (await index.httpOperation(app, e.request)).phase === 'cancelled', 'reconstructed cancellation');
    await controller.close(); controller = undefined;
    const cancelled = await index.httpOperation(app, e.request);
    assert.equal(cancelled.cancelRequestedAt, cancellation.cancelRequestedAt);
    assert.equal(cancelled.recoveryDeadline, cancellation.recoveryDeadline);
    assert.equal(cancelled.recovery.kind, 'compensated');
    assert.equal(cancelled.recovery.verified.plan, b.plan); assert.equal(cancellationReplayedWrites, 0);
    await index.reconcileHttpResources(app, e.ticket);
    assert.equal((await index.resourceSnapshot()).charges[0].result, 'previous');
    const version = (await api.request('GET', '/version')).value;
    await index.close(); index = undefined;
    // Disposable fixture only; no platform-managed registration or late unacknowledged RPC remains.
    assert.equal((await api.request('DELETE', `/services/${serviceId}`)).status, 200);
    await rm(root, { recursive: true });
    console.log(JSON.stringify({ app, engine: version.Version, api: version.ApiVersion, image,
      trustedFixtureBuildInputs: true, continuityMeasured: false, initialPromotion: true, killedAfterAcknowledgement: true, reconstructedPromotion: true, replayedWrites,
      sameServiceId: true, originalDeadline: true, settledCapacity: true, journalContainsPrivateValues: false,
      automaticRollback: true, automaticRecoveryMs, recoveryTrace, delayedCandidateFenced: true, reconstructedWorklist: true, publishedStatus: true, scheduledRestart: true, cancellationRecovered: true, cancellationReplayedWrites, recoveryCopiesReserved: 3 }));
  } catch (error) {
    await controller?.close();
    await index?.close();
    console.error(JSON.stringify({ app, root, serviceId, error: String(error), cleanup: `docker service rm ${serviceId ?? `kayra-${app}--web`}` })); process.exitCode = 1;
  }
}
