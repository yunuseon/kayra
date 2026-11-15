// Isolated synthetic-image metadata checks; no managed application is deployed.
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { registryImages } from '../../../cli/src/server/runtime/registry-images.ts';

const [base, registryImage, output, managed] = process.argv.slice(2); assert.ok(output);
assert.match(base, /^node:24\.22\.1-trixie-slim@sha256:[a-f0-9]{64}$/); assert.match(registryImage, /^registry:3\.1\.2@sha256:[a-f0-9]{64}$/);
const label = 'image-admission-' + randomUUID(); const registry = label + '-registry'; const fixture = label + '-source';
const app = 'image-lab'; const tagged = `localhost:5000/${app}/web:fixture`; const plain = `localhost:5000/${app}/plain:fixture`; const api = dockerApi();
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const identities = async () => {
  const volumes = await api.request('GET', '/volumes'); const containers = await api.request('GET', '/containers/json?all=1');
  assert.equal(volumes.status, 200); assert.equal(containers.status, 200);
  return { volumes: (volumes.value.Volumes ?? []).map((volume) => volume.Name).sort(), containers: containers.value.map((container) => container.Id).sort() };
};
let started;
try {
  docker('pull', registryImage);
  docker('run', '--detach', '--name', registry, '--label', 'io.kayra.lab=' + label, '--user', '0:0', '--restart', 'no', '--memory', '256m', '--cpus', '0.25', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--publish', '127.0.0.1:5000:5000', '--tmpfs', '/var/lib/registry:rw,size=268435456,mode=0755', registryImage);
  const readinessDeadline = Date.now() + 20000; let ready = false;
  while (Date.now() < readinessDeadline) { try { if ((await fetch('http://127.0.0.1:5000/v2/', { signal: AbortSignal.timeout(1000) })).status === 200) { ready = true; break; } } catch {} await pause(100); }
  assert.ok(ready, 'isolated registry readiness');
  docker('create', '--name', fixture, '--label', 'io.kayra.lab=' + label, '--network', 'none', '--entrypoint', 'true', base);
  docker('commit', '--change', 'VOLUME ["/data"]', fixture, tagged); docker('rm', fixture);
  const inheritedVolumes = JSON.parse(docker('image', 'inspect', '--format', '{{json .Config.Volumes}}', tagged)); assert.deepEqual(inheritedVolumes, { '/data': {} });
  docker('push', tagged);
  docker('tag', base, plain); docker('push', plain);
  // Retagging a single-platform pull can retain an unavailable index RepoDigest locally.
  const ref = async (tag) => {
    const repository = tag.slice('localhost:5000/'.length).replace(':fixture', '');
    const response = await fetch(`http://127.0.0.1:5000/v2/${repository}/manifests/fixture`, { headers: { Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' }, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length <= 1024 * 1024);
    const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex'); assert.equal(response.headers.get('docker-content-digest'), digest);
    return `localhost:5000/${repository}@${digest}`;
  };
  const inherited = await ref(tagged); const noVolumes = await ref(plain); const before = await identities(); started = new Date().toISOString();
  const port = registryImages('http://127.0.0.1:5000'); const cases = {};
  cases.exactServiceCoverage = await port.verifyDeclared(app, [{ image: inherited, kind: 'service', volumeTargets: ['/data'] }]); assert.equal(cases.exactServiceCoverage, 'accepted');
  cases.uncoveredService = await port.verifyDeclared(app, [{ image: inherited, kind: 'service', volumeTargets: [] }]); assert.equal(cases.uncoveredService, 'unsupported');
  cases.descendantMount = await port.verifyDeclared(app, [{ image: inherited, kind: 'service', volumeTargets: ['/data/child'] }]); assert.equal(cases.descendantMount, 'unsupported');
  cases.oneShot = await port.verifyDeclared(app, [{ image: inherited, kind: 'one-shot', volumeTargets: [] }]); assert.equal(cases.oneShot, 'unsupported');
  cases.mixedUsage = await port.verifyDeclared(app, [{ image: inherited, kind: 'service', volumeTargets: ['/data'] }, { image: inherited, kind: 'one-shot', volumeTargets: [] }]); assert.equal(cases.mixedUsage, 'unsupported');
  cases.legacyNoVolumes = await port.verify(app, [inherited]); assert.equal(cases.legacyNoVolumes, 'unsupported');
  cases.plainOneShot = await port.verify(app, [noVolumes]); assert.equal(cases.plainOneShot, 'accepted');
  const directResolution = await port.resolveDeclared(app, [{ image: noVolumes, kind: 'one-shot', volumeTargets: [] }]); assert.equal(directResolution.status, 'accepted');
  const selectedPin = directResolution.images[0].pull; const selectedDigest = selectedPin.split('@')[1];
  const leafReply = await fetch(`http://127.0.0.1:5000/v2/${app}/plain/manifests/${selectedDigest}`, { headers: { Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' }, signal: AbortSignal.timeout(10000) });
  assert.equal(leafReply.status, 200); const leafBytes = Buffer.from(await leafReply.arrayBuffer()); assert.ok(leafBytes.length <= 1024 * 1024);
  assert.equal('sha256:' + createHash('sha256').update(leafBytes).digest('hex'), selectedDigest);
  const leaf = JSON.parse(leafBytes.toString('utf8'));
  const indexPin = async (revision) => {
    // Fixture metadata writes precede the read-only adapter call; no image or workload is created here.
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [{ mediaType: leaf.mediaType ?? leafReply.headers.get('content-type'), digest: selectedDigest, size: leafBytes.length, platform: { os: 'linux', architecture: process.arch === 'x64' ? 'amd64' : process.arch } }], annotations: { 'io.kayra.lab.revision': revision } }));
    const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    const pushed = await fetch(`http://127.0.0.1:5000/v2/${app}/plain/manifests/${revision}`, { method: 'PUT', headers: { 'Content-Type': 'application/vnd.oci.image.index.v1+json' }, body: bytes, signal: AbortSignal.timeout(10000) });
    assert.equal(pushed.status, 201); assert.equal(pushed.headers.get('docker-content-digest'), digest); await pushed.arrayBuffer();
    return `localhost:5000/${app}/plain@${digest}`;
  };
  const sourceA = await indexPin('index-a'); const sourceB = await indexPin('index-b'); assert.notEqual(sourceA, sourceB);
  const resolvedA = await port.resolveDeclared(app, [{ image: sourceA, kind: 'one-shot', volumeTargets: [] }]);
  const resolvedB = await port.resolveDeclared(app, [{ image: sourceB, kind: 'one-shot', volumeTargets: [] }]);
  assert.equal(resolvedA.status, 'accepted'); assert.equal(resolvedB.status, 'accepted');
  assert.equal(resolvedA.images[0].source, sourceA); assert.equal(resolvedB.images[0].source, sourceB);
  assert.equal(resolvedA.images[0].pull, selectedPin); assert.equal(resolvedB.images[0].pull, selectedPin);
  const after = await identities(); assert.deepEqual(after, before);
  const result = { passed: true, scope: 'isolated real registry metadata and explicit mount coverage; not managed service rollout or volume-creation evidence', cases, inherited, noVolumes, inheritedVolumeTargets: Object.keys(inheritedVolumes), selectedNativeImages: { direct: directResolution, indexA: resolvedA, indexB: resolvedB }, registryImage, node: process.version, noContainerOrVolumeAllocationDuringAdmission: true };
  await writeFile(join(output, 'declared-images.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  if (managed === '--managed-service') await (await import('./managed-service.mjs')).probeManagedService(app, selectedPin, output);
  const logs = spawnSync('docker', ['logs', '--since', started, registry], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }); assert.equal(logs.status, 0);
  await writeFile(join(output, 'declared-images-registry.log'), logs.stdout + logs.stderr);
  docker('stop', '--time', '10', registry); docker('rm', registry);
} catch (error) {
  await writeFile(join(output, 'declared-images-failure.json'), JSON.stringify({ error: String(error), registry, fixture, started }, null, 2)); throw error;
} finally {
  const logs = spawnSync('docker', ['logs', ...(started ? ['--since', started] : []), registry], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  if (logs.status === 0) await writeFile(join(output, 'declared-images-registry.log'), logs.stdout + logs.stderr);
}
