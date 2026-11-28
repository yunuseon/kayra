// Isolated adapter evidence only; no managed app, coordinator or database is deployed here.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ownedVolume } from '../../../cli/src/contracts/owned-volume.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { ownedVolumes } from '../../../cli/src/server/runtime/owned-volume.ts';

const [image, output] = process.argv.slice(2); assert.match(image, /^node:24\.22\.1-trixie-slim@sha256:[a-f0-9]{64}$/); assert.ok(output);
await mkdir(output, { mode: 0o700 }); const api = dockerApi(); const calls = []; const events = []; let observer; let observedExit; let complete = false; let evidenceError; let bytes = 0;
const port = ownedVolumes({ request: async (...args) => { const reply = await api.request(...args); calls.push({ at: Date.now(), method: args[0], path: args[1], status: reply.status }); return reply; } });
const app = 'volume-lab-' + randomUUID().slice(0, 12); const checked = ownedVolume(app, randomUUID(), randomUUID(), 'database'); assert.ok(checked.ok); const volume = checked.value;
const action = { volume, operation: randomUUID(), deadline: Date.now() + 90000 }; const containers = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (condition) => { const end = Date.now() + 20000; while (Date.now() < end) { if (evidenceError) throw new Error(evidenceError); const value = await condition(); if (value) return value; await pause(100); } throw new Error('container completion deadline'); };
const container = async (name, source, program) => {
  const response = await api.request('POST', '/containers/create?name=' + encodeURIComponent(name), { Image: image, User: '0:0', Entrypoint: ['node'], Cmd: ['--input-type=module', '--eval', program],
    Labels: { 'io.kayra.lab': app }, Healthcheck: { Test: ['NONE'] }, HostConfig: { ReadonlyRootfs: true, NetworkMode: 'none', Memory: 134217728, NanoCpus: 250000000, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' },
      Mounts: [{ Type: 'volume', Source: source, Target: '/data', VolumeOptions: { NoCopy: true } }] } });
  assert.equal(response.status, 201); assert.match(response.value.Id, /^[a-f0-9]{64}$/); const id = response.value.Id; containers.push(id);
  assert.equal((await api.request('POST', '/containers/' + id + '/start')).status, 204);
  const state = await wait(async () => { const result = await api.request('GET', '/containers/' + id + '/json'); assert.equal(result.status, 200); return result.value.State.Running ? undefined : result.value.State; });
  assert.equal(state.ExitCode, 0); return id;
};
const removeContainer = async (id) => { assert.equal((await api.request('DELETE', '/containers/' + id + '?force=false')).status, 204); };
try {
  observer = spawn('docker', ['events', '--filter', 'type=volume', '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'] }); observedExit = once(observer, 'exit'); observer.on('error', () => { evidenceError = 'event observer failed'; }); let partial = '';
  observer.stdout.setEncoding('utf8'); observer.stdout.on('data', (chunk) => { bytes += Buffer.byteLength(chunk); if (bytes > 1024 * 1024) { evidenceError = 'event bound exceeded'; observer.kill('SIGTERM'); return; } partial += chunk; const lines = partial.split('\n'); partial = lines.pop(); for (const line of lines) if (line) { try { events.push(JSON.parse(line)); } catch { evidenceError = 'invalid event evidence'; } } });
  observer.stderr.on('data', () => { evidenceError = 'event observer error'; }); observedExit.then(() => { if (!complete) evidenceError = 'event observer ended early'; });
  await pause(200); assert.equal(await port.create(action), 'acknowledged'); const first = await port.observe(volume); assert.equal(first.status, 'owned');
  assert.equal(await port.create(action), 'acknowledged'); assert.equal(calls.filter((value) => value.method === 'POST' && value.path === '/volumes/create').length, 1);
  const a = await container(app + '-a', volume.name, 'import {writeFile} from "node:fs/promises";await writeFile("/data/value","A")');
  assert.equal(await port.remove(action, first.receipt), 'attached'); await removeContainer(a);
  const b = await container(app + '-b', volume.name, 'import {readFile,appendFile} from "node:fs/promises";if(await readFile("/data/value","utf8")!=="A")throw new Error("retained write missing");await appendFile("/data/value","B")'); await removeContainer(b);
  const restored = await container(app + '-a-restored', volume.name, 'import {readFile} from "node:fs/promises";if(await readFile("/data/value","utf8")!=="AB")throw new Error("workload recreation lost data")'); await removeContainer(restored);
  const foreignName = 'kayra-unrelated-' + randomUUID(); assert.equal((await api.request('POST', '/volumes/create', { Name: foreignName, Driver: 'local', Labels: { 'io.kayra.lab': app } })).status, 201);
  const unrelated = await container(app + '-unrelated', foreignName, 'import {writeFile} from "node:fs/promises";await writeFile("/data/value","unrelated")'); await removeContainer(unrelated);
  let revision = 0; const spec = (mounted) => ({ Name: app + '-pending', Labels: { 'io.kayra.lab': app, 'io.kayra.lab.revision': String(revision++) }, TaskTemplate: { ContainerSpec: { Image: image, Mounts: mounted ? [{ Type: 'volume', Source: volume.name, Target: '/data' }] : [] }, Resources: { Limits: { MemoryBytes: 134217728, NanoCPUs: 250000000 } }, RestartPolicy: { Condition: 'none' } }, Mode: { Replicated: { Replicas: 0 } } });
  const created = await api.request('POST', '/services/create', spec(true)); assert.equal(created.status, 201); const service = created.value.ID;
  assert.equal(await port.remove(action, first.receipt), 'attached');
  const update = async () => { const current = await api.request('GET', '/services/' + service); assert.equal(current.status, 200); assert.equal((await api.request('POST', '/services/' + service + '/update?version=' + current.value.Version.Index, spec(false))).status, 200); };
  await update(); const previous = await port.attachments(volume); assert.equal(previous.status, 'observed'); assert.ok(previous.services.includes(service)); assert.equal(await port.remove(action, first.receipt), 'attached');
  await update(); const clear = await port.attachments(volume); assert.deepEqual(clear, { status: 'observed', containers: [], services: [] });
  assert.equal(await port.remove(action, first.receipt), 'acknowledged'); assert.equal((await port.observe(volume)).status, 'absent');
  assert.equal((await api.request('GET', '/volumes/' + foreignName)).status, 200);
  const foreignRead = await container(app + '-unrelated-read', foreignName, 'import {readFile} from "node:fs/promises";if(await readFile("/data/value","utf8")!=="unrelated")throw new Error("unrelated data changed")'); await removeContainer(foreignRead);
  assert.equal((await api.request('DELETE', '/services/' + service)).status, 200); assert.equal(evidenceError, undefined);
  const result = { passed: true, scope: 'isolated local-volume runtime adapter, stopped-container and current/previous service attachments; not coordinator removal/purge, SQL or app data-retention acceptance', app, volume, receipt: first.receipt,
    retainedWritesAcrossWorkloadRecreation: true, stoppedContainerRefused: true, pendingServiceRefused: true, previousSpecRefused: true, currentAndPreviousSpecsCleared: true, exactOwnedVolumeRemoved: true, unrelatedDataPreserved: true, unrelatedVolume: foreignName,
    apiWrites: calls.filter((value) => value.method !== 'GET'), docker: (await api.request('GET', '/version')).value, cli: execFileSync('docker', ['version', '--format', '{{.Client.Version}}'], { encoding: 'utf8' }).trim(), compose: execFileSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8' }).trim(), node: process.version, os: await readFile('/etc/os-release', 'utf8'), image };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), app, volume, containers }, null, 2)); process.exitCode = 1; console.error(JSON.stringify({ error: String(error), output }));
} finally {
  if (observer && observer.exitCode === null) { complete = true; observer.kill('SIGTERM'); await observedExit; }
  await writeFile(join(output, 'docker-events.json'), JSON.stringify(events, null, 2)); await writeFile(join(output, 'requests.json'), JSON.stringify(calls, null, 2));
}
