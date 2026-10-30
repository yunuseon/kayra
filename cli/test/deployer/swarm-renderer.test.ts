import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { renderSwarmHttp } from '../../src/server/runtime/swarm.ts';

const service = {
  app: 'sample', service: 'web', registry: 'registry.internal:5000',
  image: `registry.internal:5000/sample/web@sha256:${'a'.repeat(64)}`,
  network: 'platform-swarm-public', networkId: 'qmte9yz8mohbcng0qnb2qay0r', memoryBytes: 268435456, reserveMemoryBytes: 134217728,
  nanoCpus: 1_000_000_000, reserveNanoCpus: 500_000_000,
  stopGraceSeconds: 30,
  health: { command: ['node', '/app/health.js'], intervalSeconds: 5, timeoutSeconds: 2, startPeriodSeconds: 20, retries: 3 },
};

test('renders only an HTTP workload with health, resource and VIP defaults', () => {
  const result = renderSwarmHttp(service);
  assert.equal(result.ok, true);
  assert.equal(result.value.Name, 'kayra-sample--web');
  assert.deepEqual(result.value.EndpointSpec, { Mode: 'vip' });
  assert.deepEqual(result.value.TaskTemplate.Networks, [{ Target: service.networkId }]);
  assert.deepEqual(result.value.TaskTemplate.ContainerSpec.Healthcheck.Test, ['CMD', 'node', '/app/health.js']);
  assert.equal(result.value.TaskTemplate.ContainerSpec.StopGracePeriod, 30_000_000_000);
  assert.equal(result.value.UpdateConfig.Monitor, 30_000_000_000);
  assert.equal(result.value.UpdateConfig.Order, 'start-first');
  assert.equal(result.value.UpdateConfig.FailureAction, 'rollback');
  assert.deepEqual(result.value.RollbackConfig, { Parallelism: 1, Order: 'start-first', Monitor: 30_000_000_000, FailureAction: 'pause', MaxFailureRatio: 0 });
  assert.deepEqual(result.value.TaskTemplate.Resources, {
    Limits: { MemoryBytes: service.memoryBytes, NanoCPUs: service.nanoCpus },
    Reservations: { MemoryBytes: service.reserveMemoryBytes, NanoCPUs: service.reserveNanoCpus },
  });
  assert.equal(result.value.Labels['traefik.swarm.network'], service.network);
  assert.equal(result.value.Labels['traefik.swarm.lbswarm'], 'true');
  assert.equal(Object.hasOwn(result.value.Labels, 'traefik.enable'), false);
});

test('validates registry host and port instead of accepting malformed authorities', () => {
  for (const registry of ['', 'myregistry', 'my-registry', '.registry', 'registry.', 'host..local', '-host', 'host-', 'host:0', 'host:65536', 'host:01', 'host:80:90', `host.${'a'.repeat(64)}`]) {
    assert.equal(renderSwarmHttp({ ...service, registry, image: `${registry}/sample/web@sha256:${'a'.repeat(64)}` }).ok, false, registry);
  }
  for (const registry of ['localhost', 'myregistry:5000', '127.0.0.1:5000', 'my-registry.internal:65535']) {
    assert.equal(renderSwarmHttp({ ...service, registry, image: `${registry}/sample/web@sha256:${'a'.repeat(64)}` }).ok, true, registry);
  }
});

test('permits empty health command arguments but rejects an empty executable and NUL bytes', () => {
  const result = renderSwarmHttp({ ...service, health: { ...service.health, command: ['check', '', 'argument'] } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.TaskTemplate.ContainerSpec.Healthcheck.Test, ['CMD', 'check', '', 'argument']);
  for (const command of [[''], ['check', 'bad\0arg'], [42]]) {
    assert.equal(renderSwarmHttp({ ...service, health: { ...service.health, command } }).ok, false);
  }
});

test('does not alias caller-owned command arguments in rendered data', () => {
  const command = ['check', 'original'];
  const result = renderSwarmHttp({ ...service, health: { ...service.health, command } });
  assert.equal(result.ok, true);
  assert.notEqual(result.value.TaskTemplate.ContainerSpec.Healthcheck.Test, command);
  assert.deepEqual(result.value.TaskTemplate.ContainerSpec.Healthcheck.Test, ['CMD', 'check', 'original']);
});

test('rejects unsupported workload features and untrusted routing labels', () => {
  for (const key of ['labels', 'ports', 'environment', 'secrets', 'mounts', 'dependencies', 'command', 'replicas', 'strategy']) {
    assert.equal(renderSwarmHttp({ ...service, [key]: 'anything' }).ok, false, key);
  }
  assert.equal(renderSwarmHttp({ ...service, health: { ...service.health, disable: true } }).ok, false);
});

test('rejects floating, foreign or malformed images and invalid budgets', () => {
  for (const image of ['registry.internal:5000/sample/web:latest', `registry.internal:5000/other/web@sha256:${'a'.repeat(64)}`, `registry.internal:5000/sample/../web@sha256:${'a'.repeat(64)}`]) {
    assert.equal(renderSwarmHttp({ ...service, image }).ok, false);
  }
  assert.equal(renderSwarmHttp({ ...service, reserveMemoryBytes: service.memoryBytes + 1 }).ok, false);
  assert.equal(renderSwarmHttp({ ...service, nanoCpus: 0 }).ok, false);
  assert.equal(renderSwarmHttp({ ...service, health: { ...service.health, command: [] } }).ok, false);
  assert.equal(renderSwarmHttp({ ...service, health: { ...service.health, timeoutSeconds: 6 } }).ok, false);
  assert.equal(renderSwarmHttp({ ...service, app: 'a--b' }).ok, false);
  assert.equal(renderSwarmHttp({ ...service, networkId: 'platform-swarm-public' }).ok, false);
});
