// Native adapter evidence with fixture authorization; not indexed lifecycle/admission acceptance.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ownedVolume } from '../../../cli/src/contracts/owned-volume.ts';
import { managedServiceName, managedServiceDigest, parseManagedServicePlan } from '../../../cli/src/contracts/managed-service-plan.ts';
import { managedSwarmService, renderNativeManagedService } from '../../../cli/src/server/runtime/managed-swarm-service.ts';
import { appOverlays } from '../../../cli/src/server/runtime/app-overlay.ts';
import { ownedVolumes } from '../../../cli/src/server/runtime/owned-volume.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { managedServiceBarrier } from '../../../cli/src/server/deployment/managed-service-barrier.ts';
import { managedServiceExecution } from '../../../cli/src/server/deployment/managed-service-execution.ts';
import { openJournal } from '../../../cli/src/server/deployment/journal.ts';
import { openArtifactStore } from '../../../cli/src/server/deployment/artifact-store.ts';

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
    const executionPath = join(output, 'managed-service-execution'); await mkdir(executionPath, { mode: 0o700 });
    const artifacts = await openArtifactStore(join(executionPath, 'artifacts'));
    const ports = { ...artifacts, now: Date.now, authorize: async () => true, runtime: {
      apply: (action, expected, plan) => adapter.apply(action, expected, plan, inputs),
      reactivate: (action, expected, plan) => adapter.reactivate(action, expected, plan, inputs),
      observeDesired: (action, plan) => adapter.observeDesired(action, plan, inputs),
    } };
    let journal = await openJournal(executionPath); let owner = managedServiceExecution(journal, ports); let execution;
    try {
      const prepared = await owner.prepare(first, initial, null); assert.equal(prepared.phase, 'planned');
      assert.equal((await owner.tick()).phase, 'observing');
      const creates = requests.filter((request) => request.method === 'POST' && request.path === '/services/create').length; assert.equal(creates, 1);
      await journal.close(); journal = await openJournal(executionPath, 'existing'); owner = managedServiceExecution(journal, ports);
      execution = await wait(async () => { const value = await owner.tick(); assert.notEqual(value.phase, 'held'); return value.phase === 'converged' ? value : false; }, 'reopened service execution', initial.deadline);
      assert.equal(execution.action.deadline, prepared.action.deadline); assert.equal(execution.action.action, prepared.action.action);
      assert.equal(requests.filter((request) => request.method === 'POST' && request.path === '/services/create').length, creates);
      assert.equal(JSON.stringify(await journal.read()).includes('synthetic-managed-private-value'), false);
    } finally { await journal.close(); }
    await writeFile(join(output, 'managed-service-execution.json'), JSON.stringify(execution, null, 2));
    const started = await healthy(first, initial); tracked.services.push(started.id); assert.equal(await readCounter(started), 1);
    assert.equal(JSON.stringify(started).includes('synthetic-managed-private-value'), false);
    const before = requests.filter((request) => request.method === 'POST').length;
    assert.equal(await adapter.apply(actionFor(first, 3), { id: started.id, version: started.version }, first, inputs), 'refused');
    assert.equal(requests.filter((request) => request.method === 'POST').length, before); assert.equal(await readCounter(started), 1);
    const reserveBarrier = async (service, sequence, name) => {
      const removing = actionFor(first, sequence, 'remove');
      const barrierPath = join(output, name); await mkdir(barrierPath, { mode: 0o700 });
      const barrierArtifacts = await openArtifactStore(join(barrierPath, 'artifacts'));
      const barrierPorts = { ...barrierArtifacts, now: Date.now, authorize: async () => true, runtime: { observe: adapter.observe, tombstone: adapter.tombstone } };
      let barrierJournal = await openJournal(barrierPath); let barrier = managedServiceBarrier(barrierJournal, barrierPorts); let fenced;
      try {
        const prepared = await barrier.prepare(first, removing, [{ id: service.id, version: service.version }]);
        assert.equal((await barrier.tick()).steps.length, 1);
        await barrierJournal.close(); barrierJournal = await openJournal(barrierPath, 'existing'); barrier = managedServiceBarrier(barrierJournal, barrierPorts);
        fenced = await wait(async () => { const value = await barrier.tick(); assert.notEqual(value.phase, 'held'); return value.phase === 'complete' ? value : false; }, 'reopened drained and scrubbed service barrier', removing.deadline);
        assert.equal(fenced.action.deadline, prepared.action.deadline); assert.equal(fenced.proof.native.id, service.id); assert.ok(fenced.proof.native.version > service.version);
        assert.equal(JSON.stringify(await barrierJournal.read()).includes('synthetic-managed-private-value'), false);
      } finally { await barrierJournal.close(); }
      await writeFile(join(output, name + '.json'), JSON.stringify(fenced, null, 2));
      return fenced;
    };
    const fenced = await reserveBarrier(started, 4, "managed-service-barrier");
    const reactivation = actionFor(first, 5);
    const settledBarrier = await wait(async () => { const value = await adapter.observe(scopeOf(first)); return value.status === 'owned' && value.id === fenced.proof.native.id && value.version >= fenced.proof.native.version && value.effect === 'scrub' && value.retainedInputsCleared && value.replicas === 0 && [null, 'completed', 'rollback_completed'].includes(value.update) ? value : false; }, 'stable retained activation barrier', reactivation.deadline);
    const activationVersion = { id: settledBarrier.id, version: settledBarrier.version };
    const ordinaryPosts = requests.filter((request) => request.method === 'POST').length;
    assert.equal(await adapter.apply(reactivation, activationVersion, first, inputs), 'refused');
    const changed = parseManagedServicePlan({ ...first, resources: { ...first.resources, memoryBytes: first.resources.memoryBytes + 1 } }); assert.ok(changed.ok);
    assert.equal(await adapter.reactivate({ ...reactivation, plan: managedServiceDigest(changed.value) }, activationVersion, changed.value, inputs), 'refused');
    assert.equal(requests.filter((request) => request.method === 'POST').length, ordinaryPosts);
    const reactivationPath = join(output, 'managed-service-reactivation'); await mkdir(reactivationPath, { mode: 0o700 });
    const reactivationArtifacts = await openArtifactStore(join(reactivationPath, 'artifacts'));
    let reactivationJournal = await openJournal(reactivationPath); let reactivationOwner = managedServiceExecution(reactivationJournal, { ...ports, ...reactivationArtifacts }); let activated;
    try {
      await reactivationOwner.prepare(first, reactivation, activationVersion, 'reactivate-retained');
      assert.equal((await reactivationOwner.tick()).phase, 'observing');
      await reactivationJournal.close(); reactivationJournal = await openJournal(reactivationPath, 'existing'); reactivationOwner = managedServiceExecution(reactivationJournal, { ...ports, ...reactivationArtifacts });
      activated = await wait(async () => { const state = await reactivationOwner.tick(); assert.notEqual(state.phase, 'held'); return state.phase === 'converged' ? state : false; }, 'retained reactivation after journal reopen', reactivation.deadline);
      assert.equal(activated.mode, 'reactivate-retained'); assert.equal(activated.action.deadline, reactivation.deadline);
    } finally { await reactivationJournal.close(); }
    const resumed = await healthy(first, reactivation); assert.equal(resumed.id, started.id); assert.equal(await readCounter(resumed), 2);
    await writeFile(join(output, 'managed-service-reactivation.json'), JSON.stringify(activated, null, 2));
    await reserveBarrier(resumed, 6, 'managed-service-reactivation-barrier');
    assert.equal((await api.request('POST', '/services/create', renderNativeManagedService(first, initial, inputs))).status, 409);
    const second = await planFor(randomUUID()); const recreate = actionFor(second, 2);
    assert.ok(['acknowledged', 'uncertain'].includes(await adapter.apply(recreate, null, second, inputs)));
    const restored = await healthy(second, recreate); tracked.services.push(restored.id); assert.notEqual(restored.id, started.id); assert.equal(await readCounter(restored), 3);
    assert.deepEqual(await volumes.observe(volume.value), observedVolume);
    await pause(200); finished = true; observer.kill('SIGTERM'); await observerExit; assert.equal(eventError, undefined); assert.equal(partial, '');
    const starts = tracked.services.map((id) => ({ id, starts: events.filter((event) => event.Action === 'start' && event.Actor?.Attributes?.['com.docker.swarm.service.id'] === id).length })); assert.ok(starts.every((service) => service.starts === (service.id === started.id ? 2 : 1)));
    const result = { passed: true, scope: 'native managed runtime with fixture authorization/rebinding; not indexed admission, lifecycle removal/recreation or group rollout acceptance', receipt, starts, retainedOrdinaryUpdateRefused: true, delayedOldCreateFenced: true, dataRetainedAcrossDistinctIncarnations: true, noSecretInNormalizedObservation: true, serviceExecutionJournalReopen: true, serviceExecutionOriginalDeadline: true, serviceExecutionCreates: 1, retainedReactivationJournalReopen: true, retainedReactivationPreservedPhysicalService: true, retainedReactivationRejectsChangedSpec: true, serviceBarrierJournalReopen: true, serviceBarrierOriginalDeadline: true, serviceBarrierSteps: fenced.steps.map((step) => ({ effect: step.effect, attempt: step.attempt })), node: process.version };
    await writeFile(join(output, 'managed-service.json'), JSON.stringify(result, null, 2)); return result;
  } catch (error) { await writeFile(join(output, 'managed-service-failure.json'), JSON.stringify({ error: String(error), stack: error.stack, tracked }, null, 2)); throw error; }
  finally {
    finished = true; observer.kill('SIGTERM'); await observerExit;
    await writeFile(join(output, 'managed-service-events.json'), JSON.stringify(events, null, 2)); await writeFile(join(output, 'managed-service-requests.json'), JSON.stringify(requests, null, 2)); await writeFile(join(output, 'managed-service-snapshots.json'), JSON.stringify(snapshots, null, 2));
    await writeFile(join(output, 'managed-service-event-observer.json'), JSON.stringify({ complete: eventError === undefined && partial === '', error: eventError ?? null }));
  }
};
