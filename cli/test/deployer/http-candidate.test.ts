import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';
import { compileHttpCandidate, type HttpCandidateAuthority } from '../../src/server/deployment/http-candidate.ts';
import { renderSwarmHttp } from '../../src/server/runtime/swarm.ts';

const candidate = () => ({
  app: 'shop', service: 'web', commit: 'a'.repeat(40), image: `registry.local/shop/web@sha256:${'b'.repeat(64)}`,
  strategy: 'rolling', mixedVersionCompatible: true, rollbackCompatible: true,
  resources: { memoryBytes: 256, reserveMemoryBytes: 128, nanoCpus: 1000, reserveNanoCpus: 500 },
  health: { command: ['check', '/ready'], intervalSeconds: 5, timeoutSeconds: 2, startPeriodSeconds: 20, retries: 3 },
  stopGraceSeconds: 30, route: { host: 'shop', port: 3000, check: '/ready' },
});
const registration = () => ({ app: 'shop', runtime: 'swarm', swarmEnabled: true, hosts: ['shop'], maxMemoryBytes: 256, maxNanoCpus: 1000, network: { name: 'platform-public', id: 'qmte9yz8mohbcng0qnb2qay0r' } });
const scope = () => ({ app: 'shop', commit: 'a'.repeat(40) });
const trusted = (): HttpCandidateAuthority => ({ registration: () => Promise.resolve(registration()), verifyImage: () => Promise.resolve(true) });

test('HTTP candidate requires authority, allowed route and resources', async () => {
  const result = await compileHttpCandidate(scope(), candidate(), trusted());
  strictEqual(result.ok, true);
  deepStrictEqual(result.value.network, registration().network);
  const cases: readonly (readonly [unknown, HttpCandidateAuthority])[] = [
    [{ ...candidate(), route: { ...candidate().route, host: 'other' } }, trusted()],
    [{ ...candidate(), resources: { ...candidate().resources, memoryBytes: 257 } }, trusted()],
    [candidate(), { ...trusted(), registration: () => Promise.resolve({ ...registration(), app: 'other' }) }],
    [candidate(), { ...trusted(), registration: () => Promise.resolve({ ...registration(), runtime: 'compose' }) }],
    [candidate(), { ...trusted(), registration: () => Promise.resolve({ ...registration(), swarmEnabled: false }) }],
    [candidate(), { ...trusted(), registration: () => Promise.resolve({ ...registration(), network: { name: 'platform-public', id: 'bad' } }) }],
    [candidate(), { ...trusted(), verifyImage: () => Promise.resolve(false) }],
    [{ ...candidate(), service: 'other' }, { ...trusted(), verifyImage: (request) => Promise.resolve(request.service === 'web') }],
    [{ ...candidate(), image: `registry.local/shop/other@sha256:${'b'.repeat(64)}` }, { ...trusted(), verifyImage: (request) => Promise.resolve(request.image === candidate().image) }],
  ];
  for (const [input, authority] of cases) strictEqual((await compileHttpCandidate(scope(), input, authority)).ok, false);
});

test('unknown fields and unsupported configuration fail before authority calls', async () => {
  const refused = ['environment', 'secrets', 'volumes', 'labels', 'command', 'dependencies', 'ports', 'services'];
  const authority: HttpCandidateAuthority = { registration: () => { throw new Error('must not be called'); }, verifyImage: () => { throw new Error('must not be called'); } };
  for (const field of refused) strictEqual((await compileHttpCandidate(scope(), { ...candidate(), [field]: [] }, authority)).ok, false, field);
  for (const input of [
    { ...candidate(), strategy: 'maintenance' }, { ...candidate(), mixedVersionCompatible: false },
    { ...candidate(), rollbackCompatible: false }, { ...candidate(), image: 'registry.local/shop/web:latest' },
    { ...candidate(), app: 'other' }, { ...candidate(), commit: 'c'.repeat(40) },
    { ...candidate(), image: `registry.local/shop/../web@sha256:${'b'.repeat(64)}` },
    { ...candidate(), image: `registry.local:99999/shop/web@sha256:${'b'.repeat(64)}` },
    { ...candidate(), health: { ...candidate().health, command: [] } },
    { ...candidate(), route: { ...candidate().route, check: `/${'a'.repeat(2048)}` } },
    { ...candidate(), route: { ...candidate().route, labels: {} } },
  ]) strictEqual((await compileHttpCandidate(scope(), input, authority)).ok, false);
  const longApp = 'a'.repeat(20);
  const longInput = { ...candidate(), app: longApp, service: 's'.repeat(40), image: `registry.local/${longApp}/web@sha256:${'b'.repeat(64)}` };
  strictEqual((await compileHttpCandidate({ ...scope(), app: longApp }, longInput, authority)).ok, false);
});

test('candidate workload fields are accepted by the HTTP renderer with the trusted registry', async () => {
  const result = await compileHttpCandidate(scope(), candidate(), trusted());
  strictEqual(result.ok, true);
  const plan = result.value;
  const rendered = renderSwarmHttp({
    app: plan.app, service: plan.service, registry: 'registry.local', image: plan.image,
    network: plan.network.name, networkId: plan.network.id, ...plan.resources,
    health: plan.health, stopGraceSeconds: plan.stopGraceSeconds,
  });
  strictEqual(rendered.ok, true);
  strictEqual(rendered.value.TaskTemplate.ContainerSpec.Image, plan.image);
  deepStrictEqual(rendered.value.TaskTemplate.ContainerSpec.Healthcheck.Test, ['CMD', ...plan.health.command]);
  strictEqual(rendered.value.Labels['traefik.swarm.lbswarm'], 'true');
  // This comparison covers rendering only; routing, source completeness,
  // authority freshness, admission and runtime convergence remain unproved.
});

test('candidate and renderer reject oversized and foreign image names', async () => {
  const segment = 'x'.repeat(60);
  const tooLong = `registry.local/shop/${[segment, segment, segment, segment].join('/')}@sha256:${'b'.repeat(64)}`;
  const foreign = `registry.local/other/web@sha256:${'b'.repeat(64)}`;
  for (const image of [tooLong, foreign]) {
    const input = { ...candidate(), image };
    strictEqual((await compileHttpCandidate(scope(), input, trusted())).ok, false);
    strictEqual(renderSwarmHttp({ app: input.app, service: input.service, registry: 'registry.local', image,
      network: registration().network.name, networkId: registration().network.id, ...input.resources,
      health: input.health, stopGraceSeconds: input.stopGraceSeconds }).ok, false);
  }
});

test('snapshots input before authority wait and image checks use the original identity', async () => {
  const input = candidate();
  const request = scope();
  const initial = structuredClone(input);
  const reg = registration();
  // eslint-disable-next-line functional/no-let -- controlled async interleaving
  let release: () => void = () => { throw new Error('not initialized'); };
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const authority: HttpCandidateAuthority = {
    registration: async (app) => { strictEqual(app, 'shop'); await gate; return reg; },
    verifyImage: (request) => { deepStrictEqual(request, { app: initial.app, service: initial.service, commit: initial.commit, image: initial.image }); return Promise.resolve(true); },
  };
  const pending = compileHttpCandidate(request, input, authority);
  // eslint-disable-next-line functional/immutable-data -- simulate a hostile caller during an async authority call
  input.health.command[1] = '/changed';
  // eslint-disable-next-line functional/immutable-data -- simulate substitution after invocation
  input.image = `registry.local/other/web@sha256:${'c'.repeat(64)}`;
  // eslint-disable-next-line functional/immutable-data -- attempt to change the artifact's origin
  input.service = 'other';
  // eslint-disable-next-line functional/immutable-data -- attempt to change the artifact's commit
  input.commit = 'd'.repeat(40);
  // eslint-disable-next-line functional/immutable-data -- simulate mutation of the request's scope
  request.app = 'other';
  release();
  const result = await pending;
  strictEqual(result.ok, true);
  deepStrictEqual(result.value.health.command, initial.health.command);
  strictEqual(result.value.image, initial.image);
  // eslint-disable-next-line functional/immutable-data -- authority data can change after the compiler has returned
  reg.network.name = 'different';
  strictEqual(result.value.network.name, 'platform-public');
  strictEqual(Object.isFrozen(result.value.health.command), true);
});
