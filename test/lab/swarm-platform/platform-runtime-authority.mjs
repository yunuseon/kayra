// Synthetic platform publications only. No Docker effects, admission or deployment journal access.
import { strict as assert } from 'node:assert';
import { chmod, chown, cp, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseManagedApplicationPlan } from '../../../cli/src/contracts/managed-application-plan.ts';
import { parseManagedExecutionContext } from '../../../cli/src/contracts/managed-execution-context.ts';
import { managedServiceDigest, managedServiceName } from '../../../cli/src/contracts/managed-service-plan.ts';
import { platformManagedRuntimeAuthority } from '../../../cli/src/server/platform/managed-runtime-authority.ts';
import { platformManagedPlans } from '../../../cli/src/server/composition/managed-plans.ts';
import { managedPlatform } from '../../../cli/src/server/composition/managed-platform.ts';

export const preparePlatformRuntimeAuthority = async (output, references) => {
  assert.equal(process.getuid(), 0); const root = join(output, 'input-fixtures'); const reference = references.baseline; const registration = reference.registration;
  const app = registration.app, incarnation = registration.incarnation; const owner = { version: 1, app, incarnation, dataOwner: randomUUID() }; const key = createHash('sha256').update(app).digest('hex');
  const file = async (path, value, mode = 0o444) => { await writeFile(path, JSON.stringify(value), { mode }); await chown(path, 0, 0); await chmod(path, mode); };
  const host = { version: 1, node: 'n'.repeat(25), cluster: 'c'.repeat(25), network: { name: 'platform-swarm', id: 'r'.repeat(25) }, profile: { enabled: true, advertise_address: '192.0.2.1', memory_bytes: 1073741824, cpu_millicores: 2000, platform_memory_bytes: 268435456, platform_cpu_millicores: 500 } };
  const infrastructure = { version: 1, runtime: 'swarm', registration, ownership: owner, overlay: { scope: { version: 1, app, incarnation, node: host.node, cluster: host.cluster, name: 'kayra-app-' + incarnation }, id: 'p'.repeat(25) } };
  const generation = join(key, 'generations', registration.registrationGeneration); const pub = join(root, 'public');
  await file(join(pub, generation, 'ownership.json'), { version: 1, runtime: 'swarm', registration, ownership: owner }); await file(join(pub, generation, 'infrastructure.json'), infrastructure); await file(join(pub, key, 'current.json'), registration);
  await file(join(root, 'host.json'), host); await file(join(root, 'changed-host.json'), { ...host, network: { ...host.network, id: 'z'.repeat(25) } }); await file(join(root, 'unreadable-host.json'), host, 0o600); await file(join(root, 'migration-policy.json'), { version: 1, migrationTimeoutCeilingSeconds: 300 });
  for (const name of ['wrong-current', 'wrong-owner', 'unreadable-owner']) await cp(pub, join(root, name), { recursive: true });
  await file(join(root, 'wrong-current', key, 'current.json'), references.unrelatedInputs.registration);
  await file(join(root, 'wrong-owner', generation, 'ownership.json'), { version: 1, runtime: 'swarm', registration, ownership: { ...owner, dataOwner: randomUUID() } });
  await chmod(join(root, 'unreadable-owner', generation, 'ownership.json'), 0o600);
  const image = `localhost:5000/${app}/worker@sha256:${'a'.repeat(64)}`;
  const service = { version: 1, runtime: 'swarm', owner, service: 'worker', nativeName: managedServiceName(owner, 'worker'), role: 'worker', overlap: 'forbidden', handoffCheck: null, image, inputs: reference,
    command: ['/worker'], entrypoint: null, resources: { memoryBytes: 33554432, reserveMemoryBytes: 16777216, nanoCpus: 100000000, reserveNanoCpus: 50000000 }, health: { command: ['CMD', '/health'], intervalSeconds: 2, timeoutSeconds: 1, startPeriodSeconds: 5, retries: 2 }, stopGraceSeconds: 30,
    host: { node: host.node, cluster: host.cluster, routingNetwork: null }, privateNetwork: { id: infrastructure.overlay.id, name: infrastructure.overlay.scope.name }, mounts: [], dependencies: [] };
  const application = parseManagedApplicationPlan({ version: 3, runtime: 'swarm', infrastructure, host, grants: { memory_bytes: 268435456, cpu_millicores: 500, maintenance: false }, commit: 'a'.repeat(40), artifact: 'e'.repeat(64), configurationIdentity: reference.configurationIdentity,
    hosts: [], secrets: ['PASSWORD', 'UNUSED_TOKEN'], routes: [], images: [{ source: image, pull: image, os: 'linux', architecture: process.arch === 'x64' ? 'amd64' : process.arch }],
    rollout: { strategy: 'rolling', mixed_version_compatible: true, rollback_compatible: true, services: { worker: { role: 'worker', overlap: 'forbidden' } }, migrations: [], checks: [] }, policy: { version: 1, failureMonitorSeconds: 30, updateTimeoutSeconds: 90, rollbackTimeoutSeconds: 90, migrationTimeoutCeilingSeconds: 300, checkTimeoutCeilingSeconds: 90 }, services: { worker: service } }); assert.ok(application.ok, application.ok ? '' : application.error);
  const now = Date.now(); const context = parseManagedExecutionContext({ version: 1, protocol: 'managed-v3', runtime: 'swarm', owner, run: randomUUID(), action: incarnation + ':2', source: 'e'.repeat(64), application: application.value, previous: null, allocationRequired: true, createdAt: now, admissionDeadline: now + 90000, deadline: now + 900000 }); assert.ok(context.ok); await file(join(root, 'authority-context.json'), context.value);
  const compose = { services: { worker: { image: '${WORKER_IMAGE}', command: ['/worker'], deploy: { resources: { limits: { memory: '32m', cpus: '0.1' }, reservations: { memory: '16m', cpus: '0.05' } } }, healthcheck: { test: ['CMD', '/health'], interval: '2s', timeout: '1s', start_period: '5s', retries: 2 }, stop_grace_period: '30s' } } };
  const bundle = { sha: application.value.commit, registration, rollout: application.value.rollout, images: [{ variable: 'WORKER_IMAGE', ref: image }], compose: [{ path: 'compose.yml', content: JSON.stringify(compose) }], routes: [] };
  await file(join(root, 'compiler-bundle.json'), bundle);
};

export const observePlatformRuntimeAuthority = async (output) => {
  assert.equal(process.getuid(), 1000); const root = join(output, 'input-fixtures'); const parsed = parseManagedExecutionContext(JSON.parse(await readFile(join(root, 'authority-context.json'), 'utf8'))); assert.ok(parsed.ok); const context = parsed.value;
  const port = (publicName = 'public', hostName = 'host.json', access = true) => platformManagedRuntimeAuthority({ publicRegistrations: join(root, publicName), privateRegistrations: join(root, 'private'), swarmAuthority: join(root, hostName), migrationPolicy: join(root, 'migration-policy.json'), canAccess: async () => access });
  const accepted = await port().allowed(context, { kind: 'admission' }); assert.equal(accepted, true); assert.equal(await port().allowed(context, { kind: 'service-inputs', application: context.application, service: context.application.services.worker }), true);
  const refused = {};
  for (const [name, candidate] of [['staleCurrent', port('wrong-current')], ['wrongOwner', port('wrong-owner')], ['unreadableOwner', port('unreadable-owner')], ['changedHost', port('public', 'changed-host.json')], ['unreadableHost', port('public', 'unreadable-host.json')], ['missingClaim', port('public', 'host.json', false)]]) { refused[name] = await candidate.allowed(context, { kind: 'admission' }); assert.equal(refused[name], false, name); }
  const cleanupWithoutStartGrant = await port('public', 'unreadable-host.json').allowed(context, { kind: 'migration', effect: 'fence' }); assert.equal(cleanupWithoutStartGrant, true); assert.equal(await port('unreadable-owner').allowed(context, { kind: 'migration', effect: 'fence' }), false);
  const action = { app: context.owner.app, incarnation: context.owner.incarnation, dataOwner: context.owner.dataOwner, service: 'worker', action: context.action, effect: 'remove', plan: managedServiceDigest(context.application.services.worker), deadline: Date.now() + 90000 };
  assert.equal(await port('public', 'unreadable-host.json').allowed(context, { kind: 'service', purpose: 'deployment', action }), false); assert.equal(await port('public', 'unreadable-host.json').allowed(context, { kind: 'service', purpose: 'cleanup', action }), true);
  const bytes = await readFile(join(root, 'compiler-bundle.json'), 'utf8'); const artifact = createHash('sha256').update(bytes).digest('hex'); const registryUsages = [];
  const compiler = (publicName = 'public', read = async () => bytes) => platformManagedPlans({ publicRegistrations: join(root, publicName), privateRegistrations: join(root, 'private'), swarmAuthority: join(root, 'host.json'), migrationPolicy: join(root, 'migration-policy.json'), domain: 'lab.test' }, { read, images: { resolveDeclared: async (app, usages) => {
    assert.equal(app, context.owner.app); registryUsages.push(usages); return { status: 'accepted', images: context.application.images };
  } } });
  const args = [context.application.infrastructure.registration, context.application.commit, artifact];
  assert.deepEqual(await compiler().volumeKeys(...args), []); assert.equal(registryUsages.length, 0);
  const plan = await compiler().preview(...args, []); assert.equal(plan.commit, context.application.commit); assert.equal(plan.artifact, artifact); assert.equal(plan.configurationIdentity, context.application.configurationIdentity); assert.deepEqual(plan.infrastructure, context.application.infrastructure); assert.equal(plan.services.worker.inputs.registration.registrationGeneration, context.application.infrastructure.registration.registrationGeneration); assert.equal(registryUsages.length, 1);
  await assert.rejects(compiler('wrong-current').volumeKeys(...args), /registration unavailable/); await assert.rejects(compiler('public', async () => '{}').volumeKeys(...args), /integrity/); await assert.rejects(compiler().volumeKeys(args[0], 'b'.repeat(40), artifact), /bundle unavailable/);
  const nativeReads = []; const unexpected = async () => { throw new Error('unexpected lifecycle mutation in publication probe'); };
  const index = { managedHealthContexts: async () => [context], recordedManagedVolumes: async () => [], managedRequestSource: unexpected, prepareBuild: unexpected, registrationPolicy: unexpected, reserveDataVolumeIdentities: unexpected, proposeManagedDeployment: unexpected, requestManagedDeployment: unexpected };
  const assembled = managedPlatform(index, { publicRegistrations: join(root, 'public'), privateRegistrations: join(root, 'private'), swarmAuthority: join(root, 'host.json'), migrationPolicy: join(root, 'migration-policy.json'), domain: 'lab.test' }, {
    canAccess: async () => true, builds: { now: Date.now, read: async () => bytes, retain: unexpected, prepare: unexpected, images: () => [] },
    api: { request: async (method) => { assert.equal(method, 'GET'); nativeReads.push(method); return { status: 404, value: null }; } },
  });
  await assembled.work.forRun(context); assert.deepEqual(nativeReads, []);
  const health = await assembled.healthSnapshot(); assert.deepEqual(nativeReads, []); const observed = await health.services.observe({ app: context.owner.app, incarnation: context.owner.incarnation, dataOwner: context.owner.dataOwner, service: 'worker' }); assert.equal(observed.status, 'absent'); assert.ok(nativeReads.length > 0);
  return { accepted, refused, cleanupWithoutStartGrant, deploymentStopRefusedWithoutStartGrant: true, platformRuntimeComposition: { constructedWithoutNativeAccess: true, healthUsesOnlyNativeReads: true, noLifecycleMutation: true }, platformCompiler: { passed: true, exactBundleIdentity: true, staleRegistrationRefused: true, corruptBundleRefused: true, wrongCommitRefused: true, declaredRegistryContexts: registryUsages.length, registryResolverSynthetic: true }, readerUid: process.getuid(), metadataOnly: true, scope: 'synthetic platform publication permission, compilation and composition checks; no runtime effects, admission, deployment journal, image existence or live overlay proof' };
};
