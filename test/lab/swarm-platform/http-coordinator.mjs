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
  let index; let serviceId;
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
        services: { web: { ...template.services.web, image, environment: { RELEASE: { kind: 'literal', value: commit[0] === 'a' ? 'A' : 'B' }, TOKEN: { kind: 'secret', key: 'TOKEN' } } } },
      });
      assert.ok(plan.ok); return plan.value;
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
    const resumed = httpExecution(index, { ...ports, native: { ...ports.native, apply: (...args) => { replayedWrites += 1; return ports.native.apply(...args); } } });
    await wait(async () => (await resumed.tick(app, b.request)) === 'succeeded', 'reconstructed routed B');
    const activeB = await index.httpOperation(app, b.request);
    assert.equal(activeB.verified.native.id, serviceId);
    assert.equal(activeB.deadline, b.deadline); assert.equal(replayedWrites, 0);
    assert.equal((await index.resourceSnapshot()).charges[0].result, 'target');
    assert.equal(JSON.stringify(activeB).includes(privateValue), false);
    const version = (await api.request('GET', '/version')).value;
    await index.close(); index = undefined;
    // Disposable fixture only; no platform-managed registration or late unacknowledged RPC remains.
    assert.equal((await api.request('DELETE', `/services/${serviceId}`)).status, 200);
    await rm(root, { recursive: true });
    console.log(JSON.stringify({ app, engine: version.Version, api: version.ApiVersion, image,
      trustedFixtureBuildInputs: true, continuityMeasured: false, initialPromotion: true, killedAfterAcknowledgement: true, reconstructedPromotion: true, replayedWrites,
      sameServiceId: true, originalDeadline: true, settledCapacity: true, journalContainsPrivateValues: false }));
  } catch (error) {
    await index?.close();
    console.error(JSON.stringify({ app, root, serviceId, error: String(error), cleanup: `docker service rm ${serviceId ?? `kayra-${app}--web`}` })); process.exitCode = 1;
  }
}
