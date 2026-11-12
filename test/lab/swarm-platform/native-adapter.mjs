// Isolated adapter proof. This does not authorize deployments of registered apps.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { pathToFileURL } from 'node:url';
const sourceRoot = process.env.KAYRA_LAB_SOURCE_ROOT
  ? pathToFileURL(process.env.KAYRA_LAB_SOURCE_ROOT + '/') : new URL('../../../cli/src/', import.meta.url);
const [{ parseApplicationPlan }, { swarmRouting }, { dockerApi }, { swarmService, renderNativeHttp }] = await Promise.all([
  import(new URL('contracts/application-plan.ts', sourceRoot)), import(new URL('server/platform/swarm-routing.ts', sourceRoot)),
  import(new URL('server/runtime/docker-api.ts', sourceRoot)), import(new URL('server/runtime/swarm-service.ts', sourceRoot)),
]);

const api = dockerApi();
const adapter = swarmService(api);
const app = 'native-lab-' + randomUUID().slice(0, 8);
const incarnation = randomUUID();
const name = `kayra-${app}--web`;
let serviceId;
let secondaryId;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (predicate, description) => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await pause(500);
  }
  throw new Error('timed out: ' + description);
};
const scope = { app, service: 'web', incarnation };
const observe = async () => {
  const value = await adapter.observe(scope);
  if (value.status === 'owned') serviceId = value.id;
  return value;
};
const healthy = async (plan) => {
  const value = await observe();
  if (value.status !== 'owned' || value.taskPlan !== plan) return false;
  const running = value.tasks.filter((task) => task.desired === 'running');
  return running.length === 1 && running[0].plan === plan && running[0].health === 'healthy' ? value : false;
};
const digest = (plan) => createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const action = (sequence, plan, effect = "apply") => ({ ...scope, action: `${incarnation}:${sequence}`, plan: digest(plan), deadline: Date.now() + 90_000, effect });
const version = (observation) => ({ id: observation.id, version: observation.version });
const ca = await readFile(process.env.KAYRA_LAB_CA ?? '/var/lib/kayra/swarm/lab-ca.pem');
const routed = () => new Promise((resolve, reject) => {
  const req = request({ hostname: process.env.KAYRA_LAB_ADDRESS ?? '127.0.0.1', port: 443, servername: `${app}.lab.test`, headers: { Host: `${app}.lab.test` }, path: '/', ca, agent: false, timeout: 2000 }, (response) => {
    response.resume(); response.once('end', () => resolve(response.statusCode));
  });
  req.once('timeout', () => req.destroy(new Error('routed readiness timeout'))); req.once('error', reject); req.end();
});

try {
  const planInput = JSON.parse(await readFile(process.env.KAYRA_LAB_NATIVE_PLAN ?? new URL('../../../ci/tests/swarm-http/native-plan.json', import.meta.url), 'utf8'));
  const host = JSON.parse(await readFile(process.env.KAYRA_LAB_AUTHORITY ?? '/var/lib/kayra/swarm/authority.json', 'utf8'));
  const sample = execFileSync('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=sample'], { encoding: 'utf8' }).trim();
  assert.ok(sample);
  const container = JSON.parse(execFileSync('docker', ['inspect', sample], { encoding: 'utf8' }))[0];
  const tag = `localhost:5000/${app}/web:probe`;
  execFileSync('docker', ['image', 'tag', container.Image, tag]);
  execFileSync('docker', ['image', 'push', tag], { stdio: ['ignore', 'pipe', 'pipe'] });
  const imageInfo = JSON.parse(execFileSync('docker', ['image', 'inspect', tag], { encoding: 'utf8' }))[0];
  const image = imageInfo.RepoDigests.find((ref) => ref.startsWith(`localhost:5000/${app}/web@sha256:`));
  assert.ok(image);
  const compile = (release) => {
    const parsed = parseApplicationPlan({ ...planInput, app, host,
      registration: { ...planInput.registration, app, incarnation, actionId: `${incarnation}:1` },
      commit: (release === 'A' ? 'a' : 'b').repeat(40),
      routes: planInput.routes.map((route) => ({ ...route, host: `${app}.lab.test` })),
      services: { web: { ...planInput.services.web, image, environment: { RELEASE: { kind: 'literal', value: release }, TOKEN: { kind: 'secret', key: 'TOKEN' } } } },
    });
    assert.ok(parsed.ok);
    return parsed.value;
  };
  const a = compile('A'); const b = compile('B');
  const initial = action(2, a);
  assert.equal(await adapter.apply(initial, null, a, { RELEASE: 'A', TOKEN: 'fixture-private-value' }, swarmRouting(a)), 'acknowledged');
  const before = await wait(() => healthy(initial.plan), 'healthy A');
  const verifiedA = await adapter.observeDesired(initial, a, { RELEASE: 'A', TOKEN: 'fixture-private-value' }, swarmRouting(a));
  assert.equal(verifiedA.status, 'owned'); assert.equal(verifiedA.specMatches, true);
  await wait(async () => await routed().catch(() => false) === 200, 'TLS routing A');
  const originalTasks = before.tasks.filter((task) => task.desired === 'running').map((task) => task.id);
  assert.equal(await adapter.fence(action(3, a, "fence"), version(before)), 'acknowledged');
  await pause(2000);
  const fenced = await observe(); assert.equal(fenced.status, 'owned');
  assert.ok(fenced.version > before.version);
  assert.deepEqual(fenced.tasks.filter((task) => task.desired === 'running').map((task) => task.id), originalTasks);
  assert.equal(await adapter.apply(action(4, b), version(before), b, { RELEASE: 'B', TOKEN: 'fixture-private-value' }, swarmRouting(b)), 'uncertain');
  assert.equal((await observe()).taskPlan, initial.plan);
  const update = action(4, b);
  assert.equal(await adapter.apply(update, version(fenced), b, { RELEASE: 'B', TOKEN: 'fixture-private-value' }, swarmRouting(b)), 'acknowledged');
  const replaced = await wait(async () => {
    const value = await healthy(update.plan);
    return value && value.update === 'completed' ? value : false;
  }, 'healthy completed B');
  assert.equal(await routed(), 200);
  const verifiedB = await adapter.observeDesired(update, b, { RELEASE: 'B', TOKEN: 'fixture-private-value' }, swarmRouting(b));
  assert.equal(verifiedB.status, 'owned'); assert.equal(verifiedB.specMatches, true);
  const tombstone = action(5, b, "remove");
  assert.equal(await adapter.tombstone(tombstone, version(replaced), image), 'acknowledged');
  const terminal = new Set(['shutdown', 'complete', 'failed', 'rejected', 'remove', 'orphaned']);
  const removed = await wait(async () => {
    const value = await observe();
    return value.status === 'owned' && value.tombstone && value.replicas === 0 && value.tasks.every((task) => terminal.has(task.state)) ? value : false;
  }, 'empty native tombstone');
  let raw = (await api.request('GET', `/services/${serviceId}`)).value;
  const previousSpecRetainedInputs = JSON.stringify(raw.PreviousSpec).includes('fixture-private-value');
  assert.equal(await adapter.tombstone({ ...tombstone, effect: "scrub" }, version(removed), image), 'acknowledged');
  const sealed = await observe();
  assert.equal(sealed.status, 'owned');
  assert.equal(sealed.retainedInputsCleared, true);
  raw = (await api.request('GET', `/services/${serviceId}`)).value;
  assert.equal(JSON.stringify(raw.PreviousSpec).includes('fixture-private-value'), false);
  assert.equal(raw.Spec.TaskTemplate.ContainerSpec.Env?.length ?? 0, 0);
  assert.equal(raw.Spec.TaskTemplate.Networks?.length ?? 0, 0);
  assert.equal(raw.Endpoint?.VirtualIPs?.length ?? 0, 0);
  assert.equal(removed.endpoint, 'dnsrr');
  const recreate = action(6, a);
  assert.equal(await adapter.apply(recreate, version(sealed), a, { RELEASE: 'A', TOKEN: 'fixture-private-value' }, swarmRouting(a)), 'acknowledged');
  const restored = await wait(() => healthy(recreate.plan), 'recreated A');
  assert.equal(restored.id, removed.id);
  assert.equal(await adapter.tombstone(action(7, a, "remove"), version(sealed), image), 'uncertain');
  assert.equal((await observe()).taskPlan, recreate.plan);
  const pending = parseApplicationPlan({ ...a, services: { pending: a.services.web },
    rollout: { ...a.rollout, services: { pending: { role: 'http', overlap: 'allowed' } } },
    routes: a.routes.map((route) => ({ ...route, service: 'pending' })),
  });
  assert.ok(pending.ok);
  const lateCreate = { ...action(8, pending.value), service: 'pending' };
  const cancelCreate = { ...lateCreate, action: `${incarnation}:9`, effect: 'remove' };
  assert.equal(await adapter.tombstone(cancelCreate, null, image), 'acknowledged');
  const reservedName = await adapter.observe({ ...scope, service: 'pending' });
  assert.equal(reservedName.status, 'owned'); secondaryId = reservedName.id;
  assert.equal(reservedName.replicas, 0);
  assert.equal(reservedName.retainedInputsCleared, true);
  // Simulate a create dispatched before removal and arriving after its name fence.
  const delayed = renderNativeHttp(pending.value, lateCreate, { RELEASE: 'A', TOKEN: 'fixture-private-value' }, swarmRouting(pending.value));
  assert.equal((await api.request('POST', '/services/create', delayed)).status, 409);
  assert.equal((await adapter.observe({ ...scope, service: 'pending' })).replicas, 0);
  assert.equal(JSON.stringify(restored).includes('fixture-private-value'), false);
  const engine = (await api.request('GET', '/version')).value;
  // Disposable, never-registered fixture only. Ordinary adapter removal never deletes names.
  assert.equal((await api.request('DELETE', `/services/${serviceId}`)).status, 200);
  assert.equal((await api.request('DELETE', `/services/${secondaryId}`)).status, 200);
  console.log(JSON.stringify({ app, engine: engine.Version, api: engine.ApiVersion, image,
    tlsRouting: true, exactSpecVerified: true, metadataFencePreservedTasks: true, staleReplacementRefused: true,
    completedReplacement: true, tombstoneClearedInputsAndVip: true, previousSpecRetainedInputs, tombstoneHistoryScrubbed: true, recreationKeptServiceId: true,
    staleRemovalRefused: true, delayedFirstCreateFenced: true, observedPrivateValues: JSON.stringify(restored).includes('fixture-private-value') }));
} catch (error) {
  console.error(JSON.stringify({ app, serviceId, error: String(error), cleanup: `docker service rm ${serviceId ?? name}`, extraCleanup: secondaryId === undefined ? null : `docker service rm ${secondaryId}` }));
  process.exitCode = 1;
}
