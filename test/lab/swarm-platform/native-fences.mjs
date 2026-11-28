import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dockerApi } from '/opt/kayra/server/runtime/docker-api.ts';
import { observeSwarmHost } from '/opt/kayra/server/runtime/swarm-host.ts';

const api = dockerApi();
const authority = JSON.parse(await readFile('/run/kayra-platform/swarm.json', 'utf8'));
const name = `kayra-lab-fence-${randomUUID().slice(0, 8)}`;
let serviceId;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const get = async (path) => {
  const reply = await api.request('GET', path);
  assert.equal(reply.status, 200, `Docker read failed: ${path}`);
  return reply.value;
};
const inspect = () => get(`/services/${serviceId}`);
const update = (version, spec) => api.request('POST', `/services/${serviceId}/update?version=${version}`, spec);
const tasks = () => get(`/tasks?filters=${encodeURIComponent(JSON.stringify({ service: [serviceId] }))}`);
const wait = async (condition, label) => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await pause(500);
  }
  throw new Error(`timed out: ${label}`);
};
const healthyTasks = async () => {
  const running = (await tasks()).filter((task) => task.DesiredState === 'running' && task.Status.State === 'running');
  if (running.length !== 1) return undefined;
  const container = running[0].Status.ContainerStatus?.ContainerID;
  if (container === undefined) return undefined;
  const reply = await api.request('GET', `/containers/${container}/json`);
  return reply.status === 200 && reply.value.State.Health?.Status === 'healthy' ? running.map((task) => task.ID).sort() : undefined;
};

try {
  const host = await observeSwarmHost(authority, api);
  assert.equal(host.status, 'ready');
  const legacy = await get(`/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: ['com.docker.compose.project=sample'] }))}`);
  assert.equal(legacy.length, 1);
  const imageInfo = await get(`/images/${encodeURIComponent(legacy[0].ImageID)}/json`);
  const image = imageInfo.RepoDigests.find((ref) => /^localhost:5000\/sample\/.+@sha256:[0-9a-f]{64}$/.test(ref));
  assert.ok(image);
  const spec = {
    Name: name, Labels: { 'io.kayra.lab': 'native-fences' },
    TaskTemplate: {
      ContainerSpec: { Image: image, Env: ['KAYRA_LAB_RELEASE=A'], Labels: { 'io.kayra.lab-template': 'A' },
        Healthcheck: { Test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/'], Interval: 1e9, Timeout: 1e9, Retries: 3 }, StopGracePeriod: 30e9 },
      Resources: { Limits: { MemoryBytes: 64 * 1024 ** 2, NanoCPUs: 100_000_000 }, Reservations: { MemoryBytes: 32 * 1024 ** 2, NanoCPUs: 50_000_000 } },
      RestartPolicy: { Condition: 'any', Delay: 1e9 }, Networks: [{ Target: authority.network.id }],
    },
    Mode: { Replicated: { Replicas: 1 } }, EndpointSpec: { Mode: 'vip' },
    UpdateConfig: { Parallelism: 1, Order: 'start-first', Monitor: 30e9, FailureAction: 'rollback', MaxFailureRatio: 0 },
    RollbackConfig: { Parallelism: 1, Order: 'start-first', Monitor: 30e9, FailureAction: 'pause', MaxFailureRatio: 0 },
  };
  const created = await api.request('POST', '/services/create', spec);
  assert.equal(created.status, 201);
  serviceId = created.value.ID;
  await wait(async () => (await healthyTasks()) !== undefined, 'initial healthy fixture');
  const originalTasks = await healthyTasks();
  const before = await inspect();
  const fenced = structuredClone(before.Spec);
  fenced.Labels['io.kayra.lab-fence'] = 'cancel-stale-B';
  assert.equal((await update(before.Version.Index, fenced)).status, 200);
  await pause(5_000);
  const afterFence = await inspect();
  assert.ok(afterFence.Version.Index > before.Version.Index);
  assert.deepEqual(afterFence.Spec.TaskTemplate, before.Spec.TaskTemplate);
  assert.deepEqual(await healthyTasks(), originalTasks);
  const staleB = structuredClone(before.Spec);
  staleB.TaskTemplate.ContainerSpec.Env = ['KAYRA_LAB_RELEASE=B'];
  const staleUpdate = await update(before.Version.Index, staleB);
  assert.ok(staleUpdate.status >= 400);
  assert.match(staleUpdate.value.message, /update out of sequence/);
  assert.deepEqual((await inspect()).Spec.TaskTemplate.ContainerSpec.Env, ['KAYRA_LAB_RELEASE=A']);
  assert.deepEqual(await healthyTasks(), originalTasks);
  const current = await inspect();
  const tombstone = {
    Name: name, Labels: { 'io.kayra.lab': 'native-fences', 'io.kayra.tombstone': 'true' },
    TaskTemplate: { ContainerSpec: { Image: image }, RestartPolicy: { Condition: 'none' }, Networks: [] },
    Mode: { Replicated: { Replicas: 0 } }, EndpointSpec: { Mode: 'dnsrr' },
  };
  assert.equal((await update(current.Version.Index, tombstone)).status, 200);
  const terminal = new Set(['shutdown', 'complete', 'failed', 'rejected', 'remove', 'orphaned']);
  await wait(async () => {
    const service = await inspect();
    return (await tasks()).every((task) => terminal.has(task.Status.State)) &&
      service.Spec.Mode.Replicated.Replicas === 0 && (service.Endpoint?.VirtualIPs ?? []).length === 0;
  }, 'empty native ownership tombstone');
  const removed = await inspect();
  assert.deepEqual(removed.Spec.TaskTemplate.ContainerSpec.Env ?? [], []);
  assert.deepEqual(removed.Spec.TaskTemplate.Networks ?? [], []);
  const duplicateCreate = await api.request('POST', '/services/create', spec);
  assert.equal(duplicateCreate.status, 409);
  assert.equal((await inspect()).ID, serviceId);
  const recreated = structuredClone(spec);
  recreated.Labels['io.kayra.lab-incarnation'] = 'new';
  recreated.TaskTemplate.ContainerSpec.Env = ['KAYRA_LAB_RELEASE=C'];
  recreated.TaskTemplate.ContainerSpec.Labels['io.kayra.lab-template'] = 'C';
  const recreateVersion = (await inspect()).Version.Index;
  assert.equal((await update(recreateVersion, recreated)).status, 200);
  await wait(async () => (await healthyTasks()) !== undefined, 'recreated fixture');
  const recreatedTasks = await healthyTasks();
  assert.notDeepEqual(recreatedTasks, originalTasks);
  const staleRemoval = await update(recreateVersion, tombstone);
  assert.ok(staleRemoval.status >= 400);
  assert.match(staleRemoval.value.message, /update out of sequence/);
  assert.deepEqual(await healthyTasks(), recreatedTasks);
  assert.deepEqual((await inspect()).Spec.TaskTemplate.ContainerSpec.Env, ['KAYRA_LAB_RELEASE=C']);
  const version = await get('/version');
  assert.equal((await api.request('DELETE', `/services/${serviceId}`)).status, 200);
  console.log(JSON.stringify({ engine: version.Version, api: version.ApiVersion, image, host,
    metadataFencePreservedTasks: true, staleUpdateStatus: staleUpdate.status,
    tombstoneFreedVip: true, tombstoneClearedEnvironment: true, duplicateCreateStatus: duplicateCreate.status,
    recreationKeptServiceId: true, staleRemovalStatus: staleRemoval.status, originalTasks, recreatedTasks }));
} catch (error) {
  console.error(JSON.stringify({ fixture: name, serviceId, cleanup: serviceId === undefined ? null : `docker service rm ${serviceId}`, error: String(error) }));
  process.exitCode = 1;
}
