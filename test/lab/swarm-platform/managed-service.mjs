// Native adapter evidence with fixture authorization; not indexed lifecycle/admission acceptance.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ownedVolume } from '../../../cli/src/contracts/owned-volume.ts';
import { managedServiceName, managedServiceDigest, parseManagedServicePlan } from '../../../cli/src/contracts/managed-service-plan.ts';
import { managedSwarmService, renderNativeManagedService } from '../../../cli/src/server/runtime/managed-swarm-service.ts';
import { appOverlays } from '../../../cli/src/server/runtime/app-overlay.ts';
import { ownedVolumes } from '../../../cli/src/server/runtime/owned-volume.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (predicate, description, deadline) => {
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await pause(100); }
  throw new Error('native managed deadline: ' + description);
};
export const probeManagedService = async (app, image, output) => {
  const transport = dockerApi(); const snapshots = []; const requests = []; const events = []; let eventError; let finished = false; let partial = ''; let bytes = 0;
  const api = { request: async (...args) => {
    assert.ok(requests.length < 8192, 'request evidence bound');
    const reply = await transport.request(...args); requests.push({ at: Date.now(), method: args[0], path: args[1], status: reply.status });
    if (args[0] === 'GET' && args[1].startsWith('/services/')) { assert.ok(snapshots.length < 4096, 'snapshot evidence bound'); snapshots.push({ at: Date.now(), path: args[1], value: reply.value }); }
    return reply;
  } };
  const observer = spawn('docker', ['events', '--filter', 'type=container', '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'] }); const observerExit = once(observer, 'exit');
  observer.on('error', () => { eventError = 'event observer failed'; }); observer.stderr.on('data', () => { eventError = 'event observer stderr'; });
  observer.stdout.setEncoding('utf8'); observer.stdout.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk); if (bytes > 1024 * 1024) { eventError = 'event bound'; observer.kill(); return; }
    partial += chunk; const lines = partial.split('\n'); partial = lines.pop();
    for (const line of lines) if (line) { try { events.push(JSON.parse(line)); } catch { eventError = 'invalid event'; } }
  }); observerExit.then(() => { if (!finished) eventError = 'event stream ended early'; });
  const volumes = ownedVolumes(api); const overlays = appOverlays(api); const adapter = managedSwarmService(api, volumes); const tracked = { services: [], networks: [], volume: null };
  const terminal = new Set(['shutdown', 'complete', 'failed', 'rejected', 'remove', 'orphaned']);
  try {
    await pause(200); const info = await api.request('GET', '/info'); assert.equal(info.status, 200); const host = info.value.Swarm;
    const dataOwner = randomUUID(); const volume = ownedVolume(app, dataOwner, randomUUID(), 'data'); assert.ok(volume.ok); tracked.volume = volume.value;
    const volumeAction = { volume: volume.value, operation: randomUUID(), deadline: Date.now() + 90000 }; assert.ok(['acknowledged', 'uncertain'].includes(await volumes.create(volumeAction)));
    const observedVolume = await volumes.observe(volume.value); assert.equal(observedVolume.status, 'owned'); const receipt = observedVolume.receipt;
    const receiptFile = await open(join(output, 'managed-volume-receipt.json'), 'wx', 0o600); try { await receiptFile.writeFile(JSON.stringify(receipt)); await receiptFile.sync(); } finally { await receiptFile.close(); }
    const directory = await open(output, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    const planFor = async (incarnation) => {
      const scope = { version: 1, app, incarnation, node: host.NodeID, cluster: host.Cluster.ID, name: `kayra-app-${incarnation}` };
      const deadline = Date.now() + 90000; assert.ok(['acknowledged', 'uncertain'].includes(await overlays.create({ scope, operation: randomUUID(), deadline })));
      const overlay = await wait(async () => { const value = await overlays.observe(scope); return value.status === 'owned' ? value.grant : false; }, 'private overlay', deadline); tracked.networks.push(overlay.id);
      const parsed = parseManagedServicePlan({ version: 1, runtime: 'swarm', owner: { version: 1, app, incarnation, dataOwner }, service: 'db', nativeName: managedServiceName({ app, incarnation }, 'db'), role: 'retained-dependency', overlap: 'forbidden', handoffCheck: null, image,
        inputs: { version: 1, registration: { version: 1, app, incarnation, actionId: `${incarnation}:1`, registrationGeneration: randomUUID() }, configurationIdentity: 'sha256:' + 'c'.repeat(64), environment: { TOKEN: { kind: 'secret', key: 'TOKEN' } } },
        command: ['--eval', 'const fs=require("node:fs");const path="/data/starts";const before=fs.existsSync(path)?Number(fs.readFileSync(path,"utf8")):0;const file=fs.openSync(path,"w");fs.writeFileSync(file,String(before+1));fs.fsyncSync(file);fs.closeSync(file);setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0));'], entrypoint: ['node'],
        resources: { memoryBytes: 134217728, reserveMemoryBytes: 67108864, nanoCpus: 250000000, reserveNanoCpus: 125000000 }, health: { command: ['node', '-e', 'process.exit(require("node:fs").existsSync("/data/starts")?0:1)'], intervalSeconds: 1, timeoutSeconds: 1, startPeriodSeconds: 1, retries: 3 }, stopGraceSeconds: 30,
        host: { node: host.NodeID, cluster: host.Cluster.ID, routingNetwork: null }, privateNetwork: { id: overlay.id, name: overlay.scope.name }, mounts: [{ volume: volume.value, target: '/data', readOnly: false, noCopy: true }], dependencies: [],
      }); assert.ok(parsed.ok); return parsed.value;
    };
    const inputs = { environment: { TOKEN: 'synthetic-managed-private-value' }, routing: {}, volumes: [receipt] };
    const scopeOf = (plan) => ({ app, service: plan.service, incarnation: plan.owner.incarnation, dataOwner });
    const actionFor = (plan, sequence, effect = 'apply') => ({ ...scopeOf(plan), action: `${plan.owner.incarnation}:${sequence}`, plan: managedServiceDigest(plan), deadline: Date.now() + 90000, effect });
    const healthy = async (plan, action) => wait(async () => {
      const value = await adapter.observeDesired(action, plan, inputs);
      return value.status === 'owned' && value.action === action.action && value.taskPlan === action.plan && value.specMatches && value.tasks.filter((task) => task.desired === 'running' && task.state === 'running' && task.health === 'healthy').length === 1 ? value : false;
    }, 'healthy mounted service', action.deadline);
    const readCounter = async (service) => {
      const tasks = await api.request('GET', '/tasks?filters=' + encodeURIComponent(JSON.stringify({ service: [service.id], 'desired-state': ['running'] }))); assert.equal(tasks.status, 200);
      const active = tasks.value.filter((task) => task.ServiceID === service.id && task.DesiredState === 'running' && task.Status.State === 'running'); assert.equal(active.length, 1);
      const id = active[0].Status.ContainerStatus.ContainerID; assert.match(id, /^[a-f0-9]{64}$/);
      return Number(execFileSync('docker', ['exec', id, 'node', '-e', 'process.stdout.write(require("node:fs").readFileSync("/data/starts","utf8"))'], { encoding: 'utf8', timeout: 10000 }));
    };
    const first = await planFor(randomUUID()); const initial = actionFor(first, 2);
    assert.ok(['acknowledged', 'uncertain'].includes(await adapter.apply(initial, null, first, inputs)));
    const started = await healthy(first, initial); tracked.services.push(started.id); assert.equal(await readCounter(started), 1);
    assert.equal(JSON.stringify(started).includes('synthetic-managed-private-value'), false);
    const before = requests.filter((request) => request.method === 'POST').length;
    assert.equal(await adapter.apply(actionFor(first, 3), { id: started.id, version: started.version }, first, inputs), 'refused');
    assert.equal(requests.filter((request) => request.method === 'POST').length, before); assert.equal(await readCounter(started), 1);
    const removing = actionFor(first, 4, 'remove'); assert.ok(['acknowledged', 'uncertain'].includes(await adapter.tombstone(removing, { id: started.id, version: started.version }, image)));
    const empty = await wait(async () => { const value = await adapter.observe(scopeOf(first)); return value.status === 'owned' && value.action === removing.action && value.effect === 'remove' && value.replicas === 0 && value.tasks.every((task) => terminal.has(task.state)) ? value : false; }, 'empty retained tombstone', removing.deadline);
    const scrubbing = { ...removing, effect: 'scrub' }; assert.ok(['acknowledged', 'uncertain'].includes(await adapter.tombstone(scrubbing, { id: empty.id, version: empty.version }, image)));
    await wait(async () => { const value = await adapter.observe(scopeOf(first)); return value.status === 'owned' && value.effect === 'scrub' && value.retainedInputsCleared ? value : false; }, 'scrubbed retained tombstone', scrubbing.deadline);
    assert.equal((await api.request('POST', '/services/create', renderNativeManagedService(first, initial, inputs))).status, 409);
    const second = await planFor(randomUUID()); const recreate = actionFor(second, 2);
    assert.ok(['acknowledged', 'uncertain'].includes(await adapter.apply(recreate, null, second, inputs)));
    const restored = await healthy(second, recreate); tracked.services.push(restored.id); assert.notEqual(restored.id, started.id); assert.equal(await readCounter(restored), 2);
    assert.deepEqual(await volumes.observe(volume.value), observedVolume);
    await pause(200); finished = true; observer.kill('SIGTERM'); await observerExit; assert.equal(eventError, undefined); assert.equal(partial, '');
    const starts = tracked.services.map((id) => ({ id, starts: events.filter((event) => event.Action === 'start' && event.Actor?.Attributes?.['com.docker.swarm.service.id'] === id).length })); assert.ok(starts.every((service) => service.starts === 1));
    const result = { passed: true, scope: 'native managed runtime with fixture authorization/rebinding; not indexed admission, lifecycle removal/recreation or group rollout acceptance', receipt, starts, retainedOrdinaryUpdateRefused: true, delayedOldCreateFenced: true, dataRetainedAcrossDistinctIncarnations: true, noSecretInNormalizedObservation: true, node: process.version };
    await writeFile(join(output, 'managed-service.json'), JSON.stringify(result, null, 2)); return result;
  } catch (error) { await writeFile(join(output, 'managed-service-failure.json'), JSON.stringify({ error: String(error), stack: error.stack, tracked }, null, 2)); throw error; }
  finally {
    finished = true; observer.kill('SIGTERM'); await observerExit;
    await writeFile(join(output, 'managed-service-events.json'), JSON.stringify(events, null, 2)); await writeFile(join(output, 'managed-service-requests.json'), JSON.stringify(requests, null, 2)); await writeFile(join(output, 'managed-service-snapshots.json'), JSON.stringify(snapshots, null, 2));
    await writeFile(join(output, 'managed-service-event-observer.json'), JSON.stringify({ complete: eventError === undefined && partial === '', error: eventError ?? null }));
  }
};
