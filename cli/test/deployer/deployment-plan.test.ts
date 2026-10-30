import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ownedVolumeName, parseDeploymentPlan, validateRetainedDependencies } from '../../src/contracts/deployment-plan.ts';

const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
const secret = `sg_${'a'.repeat(32)}`;
const db = { role: 'retained-dependency', overlap: 'forbidden', image: `registry.internal/sample/db@${digest('a')}`, specification: digest('b'), configuration: digest('c'), secretGenerations: [secret], dependencies: [], volumes: ['data'] };
const web = { role: 'http', overlap: 'allowed', image: `registry.internal/sample/web@${digest('d')}`, specification: digest('e'), configuration: digest('f'), secretGenerations: [], dependencies: ['db'], volumes: [] };
const plan = { version: 1, app: 'sample', runtime: 'swarm', configuration: digest('1'), grants: { maintenance: false, memoryBytes: 1024, nanoCpus: 1000000000 }, volumes: { data: { identity: `vol_${'a'.repeat(32)}`, runtimeName: ownedVolumeName('sample', 'data', `vol_${'a'.repeat(32)}`) } }, services: { db, web } };

test('validates and freezes the normalized plan and accepts unchanged retained dependencies', () => {
  const first = parseDeploymentPlan(plan);
  const next = parseDeploymentPlan({ ...plan, services: { db, web: { ...web, image: `registry.internal/sample/web@${digest('9')}` } } });
  assert.equal(first.ok, true);
  assert.equal(next.ok, true);
  assert.equal(Object.isFrozen(first.value), true);
  assert.equal(Object.isFrozen(first.value.services['db']?.dependencies), true);
  assert.equal(validateRetainedDependencies(first.value, next.value).ok, true);
});

test('rejects unsupported fields, secret values and nonimmutable references', () => {
  assert.equal(parseDeploymentPlan({ ...plan, resolvedSecrets: { password: 'value' } }).ok, false);
  assert.equal(parseDeploymentPlan({ ...plan, services: { db: { ...db, secretGenerations: ['plaintext'] }, web } }).ok, false);
  assert.equal(parseDeploymentPlan({ ...plan, services: { db: { ...db, environment: { PASSWORD: 'value' } }, web } }).ok, false);
  assert.equal(parseDeploymentPlan({ ...plan, services: { db: { ...db, image: 'registry.internal/sample/db:latest' }, web } }).ok, false);
  assert.equal(parseDeploymentPlan({ ...plan, grants: { ...plan.grants, memoryBytes: 0 } }).ok, false);
});

test('snapshots indexed references without trusting sparse arrays or input iterators', () => {
  const invalid: readonly unknown[] = Array(1);
  assert.equal(parseDeploymentPlan({ ...plan, services: { db: { ...db, secretGenerations: invalid }, web } }).ok, false);
  assert.equal(parseDeploymentPlan({ ...plan, services: { db, web: { ...web, dependencies: invalid } } }).ok, false);
  assert.equal(parseDeploymentPlan({ ...plan, services: { db: { ...db, volumes: invalid }, web } }).ok, false);

  const references = [secret, `sg_${'b'.repeat(32)}`];
  // eslint-disable-next-line functional/immutable-data -- simulate untrusted array methods
  Object.defineProperty(references, Symbol.iterator, { value: function* () { yield secret; yield 'plain-secret'; } });
  // eslint-disable-next-line functional/immutable-data -- simulate untrusted array methods
  Object.defineProperty(references, 'every', { value: () => true });
  const parsed = parseDeploymentPlan({ ...plan, services: { db: { ...db, secretGenerations: references }, web } });
  assert.equal(parsed.ok, true);
  const snapshot = parsed.value.services['db']?.secretGenerations;
  assert.deepEqual(snapshot, [secret, `sg_${'b'.repeat(32)}`]);
  // eslint-disable-next-line functional/immutable-data -- prove output does not share input
  references[0] = `sg_${'c'.repeat(32)}`;
  assert.deepEqual(snapshot, [secret, `sg_${'b'.repeat(32)}`]);
  assert.equal(Object.isFrozen(snapshot), true);
});

test('rejects invalid dependencies, cycles and unowned or duplicate volume identities', () => {
  assert.equal(parseDeploymentPlan({ ...plan, services: { db: { ...db, dependencies: ['web'] }, web } }).ok, false);
  assert.equal(parseDeploymentPlan({ ...plan, services: { db, web: { ...web, dependencies: ['missing'] } } }).ok, false);
  assert.equal(parseDeploymentPlan({ ...plan, services: { db: { ...db, volumes: ['missing'] }, web } }).ok, false);
  assert.equal(parseDeploymentPlan({ ...plan, volumes: { data: { ...plan.volumes.data, runtimeName: 'other-app-data' } } }).ok, false);
  assert.equal(parseDeploymentPlan({ ...plan, volumes: { ...plan.volumes, more: { ...plan.volumes.data, runtimeName: ownedVolumeName('sample', 'more', `vol_${'a'.repeat(32)}`) } } }).ok, false);
});

test('rejects retained dependency specification, reference and volume changes', () => {
  const first = parseDeploymentPlan(plan);
  assert.equal(first.ok, true);
  for (const replacement of [
    { ...db, image: `registry.internal/sample/db@${digest('9')}` },
    { ...db, configuration: digest('9') },
    { ...db, secretGenerations: [`sg_${'b'.repeat(32)}`] },
    { ...db, specification: digest('9') },
  ]) {
    const next = parseDeploymentPlan({ ...plan, services: { db: replacement, web } });
    assert.equal(next.ok, true);
    assert.equal(validateRetainedDependencies(first.value, next.value).ok, false);
  }
  const changedVolume = parseDeploymentPlan({ ...plan, volumes: { data: { ...plan.volumes.data, identity: `vol_${'b'.repeat(32)}`, runtimeName: ownedVolumeName('sample', 'data', `vol_${'b'.repeat(32)}`) } } });
  assert.equal(changedVolume.ok, true);
  assert.equal(validateRetainedDependencies(first.value, changedVolume.value).ok, false);
  const removed = parseDeploymentPlan({ ...plan, services: { web: { ...web, dependencies: [] } } });
  assert.equal(removed.ok, true);
  assert.equal(validateRetainedDependencies(first.value, removed.value).ok, false);
});


test('volume runtime names unambiguously bind app, key and owned identity', () => {
  const identity = `vol_${'a'.repeat(32)}`;
  assert.notEqual(ownedVolumeName('a-b', 'c', identity), ownedVolumeName('a', 'b-c', identity));
  assert.notEqual(ownedVolumeName('sample', 'data', identity), ownedVolumeName('sample', 'data', `vol_${'b'.repeat(32)}`));
  assert.equal(parseDeploymentPlan({ ...plan, volumes: { data: { identity, runtimeName: 'kayra-sample-data' } } }).ok, false);
});
