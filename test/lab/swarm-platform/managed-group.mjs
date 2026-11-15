// Fixture-authorized retained startup, migration and worker phases. No indexed admission or release promotion.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ownedVolume } from '../../../cli/src/contracts/owned-volume.ts';
import { managedServiceDigest, managedServiceName } from '../../../cli/src/contracts/managed-service-plan.ts';
import { parseManagedApplicationPlan } from '../../../cli/src/contracts/managed-application-plan.ts';
import { managedGroupPreparation } from '../../../cli/src/server/deployment/managed-group-preparation.ts';
import { managedGroupCompensation } from '../../../cli/src/server/deployment/managed-group-compensation.ts';
import { managedServiceCompensation } from '../../../cli/src/server/deployment/managed-service-compensation.ts';
import { convergedService } from '../../../cli/src/server/deployment/service-convergence.ts';
import { managedConsumerRollout } from '../../../cli/src/server/deployment/managed-consumer-rollout.ts';
import { managedMigrationInputs } from '../../../cli/src/server/deployment/managed-migration-inputs.ts';
import { openJournal } from '../../../cli/src/server/deployment/journal.ts';
import { openArtifactStore } from '../../../cli/src/server/deployment/artifact-store.ts';
import { managedSwarmService } from '../../../cli/src/server/runtime/managed-swarm-service.ts';
import { oneShotJob } from '../../../cli/src/server/runtime/one-shot-job.ts';
import { ownedVolumes } from '../../../cli/src/server/runtime/owned-volume.ts';
import { appOverlays } from '../../../cli/src/server/runtime/app-overlay.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (check, deadline, description) => {
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(100); }
  throw new Error('managed group fixture deadline: ' + description);
};
export const probeManagedGroup = async (app, databaseImage, migrationImage, output) => {
  const path = join(output, 'managed-group'); await mkdir(path, { mode: 0o700 });
  const events = []; const requests = []; let partial = ''; let eventError; let finished = false; let bytes = 0;
  const eventProcess = spawn('docker', ['events', '--filter', 'type=container', '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'] }); const eventExit = once(eventProcess, 'exit');
  eventProcess.on('error', () => { eventError = 'event observer failed'; }); eventProcess.stderr.on('data', () => { eventError = 'event observer stderr'; });
  eventProcess.stdout.setEncoding('utf8'); eventProcess.stdout.on('data', (value) => {
    bytes += Buffer.byteLength(value); if (bytes > 8 * 1024 * 1024) { eventError = 'event evidence bound'; eventProcess.kill(); return; }
    partial += value; const lines = partial.split('\n'); partial = lines.pop();
    for (const line of lines) if (line) { try { events.push(JSON.parse(line)); } catch { eventError = 'invalid event'; } }
  }); eventExit.then(() => { if (!finished) eventError = 'event observer ended early'; });
  const transport = dockerApi(); const api = { request: async (...args) => { assert.ok(requests.length < 16384); const reply = await transport.request(...args); requests.push({ at: Date.now(), method: args[0], path: args[1], status: reply.status }); return reply; } };
  let journal; let consumerJournal; let compensationJournal; let groupPreparationJournal; let groupConsumerJournal; let groupRecoveryJournal;
  try {
    await pause(200); const info = await api.request('GET', '/info'); assert.equal(info.status, 200); const swarm = info.value.Swarm;
    const incarnation = randomUUID(); const dataOwner = randomUUID(); const registration = { version: 1, app, incarnation, actionId: incarnation + ':1', registrationGeneration: randomUUID() };
    const ownership = { version: 1, app, incarnation, dataOwner }; const scope = { version: 1, app, incarnation, node: swarm.NodeID, cluster: swarm.Cluster.ID, name: 'kayra-app-' + incarnation };
    const deadline = Date.now() + 90000; const overlay = appOverlays(api); assert.ok(['acknowledged', 'uncertain'].includes(await overlay.create({ scope, operation: randomUUID(), deadline })));
    const grant = await wait(async () => { const value = await overlay.observe(scope); return value.status === 'owned' ? value.grant : false; }, deadline, 'private overlay');
    const routing = await api.request('POST', '/networks/create', { Name: 'platform-swarm', Driver: 'overlay', Attachable: true, CheckDuplicate: true }); assert.equal(routing.status, 201); assert.match(routing.value.Id, /^[a-z0-9]{25}$/);
    const allocation = ownedVolume(app, dataOwner, randomUUID(), 'data'); assert.ok(allocation.ok); const volumes = ownedVolumes(api);
    assert.ok(['acknowledged', 'uncertain'].includes(await volumes.create({ volume: allocation.value, operation: randomUUID(), deadline })));
    const observedVolume = await volumes.observe(allocation.value); assert.equal(observedVolume.status, 'owned'); const receipt = observedVolume.receipt;
    const receiptFile = await open(join(path, 'receipt.json'), 'wx', 0o600); try { await receiptFile.writeFile(JSON.stringify(receipt)); await receiptFile.sync(); } finally { await receiptFile.close(); }
    const directory = await open(path, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    const ledgerCode = `const fs=require('node:fs'),http=require('node:http');const file='/data/ledger.json';let ledger=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];const save=()=>{const fd=fs.openSync(file,'w');fs.writeFileSync(fd,JSON.stringify(ledger));fs.fsyncSync(fd);fs.closeSync(fd)};save();http.createServer((req,res)=>{const u=new URL(req.url,'http://db');if(u.pathname==='/apply'){const id=u.searchParams.get('id');if(!ledger.includes(id)){ledger.push(id);save()}}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({healthy:true,ledger}))}).listen(8080,'0.0.0.0');process.on('SIGTERM',()=>process.exit(0));`;
    const health = { command: ['node', '-e', `fetch('http://127.0.0.1:8080/health',{signal:AbortSignal.timeout(750)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`], intervalSeconds: 1, timeoutSeconds: 1, startPeriodSeconds: 1, retries: 3 };
    const inputs = (environment) => ({ version: 1, registration, configurationIdentity: 'sha256:' + 'c'.repeat(64), environment });
    const spec = (name, role, image, environment, mounts, command) => ({ version: 1, runtime: 'swarm', owner: ownership, service: name, nativeName: managedServiceName(ownership, name), role, overlap: 'forbidden', handoffCheck: null, image, inputs: inputs(environment), command, entrypoint: ['node'],
      resources: { memoryBytes: 134217728, reserveMemoryBytes: 67108864, nanoCpus: 250000000, reserveNanoCpus: 125000000 }, health: role === 'worker' ? { ...health, command: ['node', '-e', 'process.exit(0)'] } : health, stopGraceSeconds: 30,
      host: { node: swarm.NodeID, cluster: swarm.Cluster.ID, routingNetwork: null }, privateNetwork: { id: grant.id, name: grant.scope.name }, mounts, dependencies: name === 'worker' ? [{ service: 'db', condition: 'healthy' }] : [] });
    const migrateCode = `const url='http://db:8080/apply?id='+encodeURIComponent(process.env.KAYRA_OPERATION_ID);fetch(url,{signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok)process.exit(1);await r.text();setTimeout(()=>process.exit(0),2000)}).catch(()=>process.exit(1));`;
    const checked = parseManagedApplicationPlan({ version: 3, runtime: 'swarm', infrastructure: { version: 1, runtime: 'swarm', registration, ownership, overlay: grant }, commit: 'd'.repeat(40), artifact: 'e'.repeat(64), configurationIdentity: 'sha256:' + 'c'.repeat(64),
      host: { version: 1, node: swarm.NodeID, cluster: swarm.Cluster.ID, network: { name: 'platform-swarm', id: routing.value.Id }, profile: { enabled: true, advertise_address: swarm.NodeAddr, memory_bytes: 3221225472, cpu_millicores: 2000, platform_memory_bytes: 1073741824, platform_cpu_millicores: 500 } },
      grants: { memory_bytes: 536870912, cpu_millicores: 1000, maintenance: false }, hosts: [], secrets: ['TOKEN'], routes: [],
      rollout: { strategy: 'rolling', mixed_version_compatible: true, rollback_compatible: true, services: { db: { role: 'retained-dependency', overlap: 'forbidden' }, worker: { role: 'worker', overlap: 'forbidden' } }, migrations: [{ id: 'schema', service: 'worker', command: ['--eval', migrateCode], timeout_seconds: 30, recovery: { kind: 'replay-safe' } }], checks: [] },
      policy: { version: 1, failureMonitorSeconds: 30, updateTimeoutSeconds: 90, rollbackTimeoutSeconds: 90, migrationTimeoutCeilingSeconds: 90, checkTimeoutCeilingSeconds: 90 },
      images: [...new Set([databaseImage, migrationImage])].map((image) => ({ source: image, pull: image, os: 'linux', architecture: process.arch === 'x64' ? 'amd64' : process.arch })),
      services: { db: spec('db', 'retained-dependency', databaseImage, {}, [{ volume: allocation.value, target: '/data', readOnly: false, noCopy: true }], ['--eval', ledgerCode]),
        worker: spec('worker', 'worker', migrationImage, { TOKEN: { kind: 'secret', key: 'TOKEN' } }, [], ['--eval', 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)']) },
    }); assert.ok(checked.ok, checked.ok ? '' : checked.error); const plan = checked.value;
    await writeFile(join(path, 'fixture-plan.json'), JSON.stringify(plan, null, 2), { mode: 0o600 });
    const artifacts = await openArtifactStore(join(path, 'artifacts')); const serviceRuntime = managedSwarmService(api, volumes); const jobs = oneShotJob(api); let started = false;
    const serviceInputs = (service) => ({ environment: Object.fromEntries(Object.entries(service.inputs.environment).map(([key, binding]) => [key, binding.kind === 'literal' ? binding.value : 'synthetic-group-private-value'])), routing: {}, volumes: service.mounts.length === 0 ? [] : [receipt] });
    const ports = { ...artifacts, now: Date.now, authorize: async () => true, services: { observe: serviceRuntime.observe,
      observeDesired: (action, service) => serviceRuntime.observeDesired(action, service, serviceInputs(service)),
      apply: (action, expected, service) => serviceRuntime.apply(action, expected, service, serviceInputs(service)),
      reactivate: (action, expected, service) => serviceRuntime.reactivate(action, expected, service, serviceInputs(service)),
    }, jobs: { observe: jobs.observe, fence: jobs.fence,
      create: async (job) => { const reference = managedMigrationInputs(plan, job); assert.ok(reference.ok); const environment = Object.fromEntries(Object.entries(reference.value.environment).map(([key, binding]) => [key, binding.kind === 'literal' ? binding.value : 'synthetic-group-private-value'])); return jobs.create(job, environment); },
      start: async (...args) => { const result = await jobs.start(...args); if (result === 'acknowledged') started = true; return result; },
    } };
    journal = await openJournal(path); let owner = managedGroupPreparation(journal, ports); const run = randomUUID(); const prepared = await owner.prepare(plan, run, incarnation + ':2', []);
    await wait(async () => { const state = await owner.tick(); assert.notEqual(state.phase, 'held'); return started; }, prepared.migrationDeadline, 'migration Start');
    const interrupted = await owner.read(); assert.ok(interrupted.sequence?.steps[0]?.attempts[0]?.execution?.container);
    await journal.close(); journal = await openJournal(path, 'existing'); owner = managedGroupPreparation(journal, ports);
    const ready = await wait(async () => { const state = await owner.tick(); assert.notEqual(state.phase, 'held'); return state.phase === 'ready' ? state : false; }, prepared.migrationDeadline, 'reopened preparation');
    assert.equal(ready.startupDeadline, prepared.startupDeadline); assert.equal(ready.migrationDeadline, prepared.migrationDeadline); assert.equal(ready.sequence.steps[0].executionDeadline, interrupted.sequence.steps[0].executionDeadline);
    assert.equal(JSON.stringify(await journal.read()).includes('synthetic-group-private-value'), false);
    const database = ready.nodes.find((node) => node.name === 'db'); assert.ok(database.ready);
    const tasks = await api.request('GET', '/tasks?filters=' + encodeURIComponent(JSON.stringify({ service: [database.ready.native.id], 'desired-state': ['running'] }))); assert.equal(tasks.status, 200);
    const task = tasks.value.find((value) => value.DesiredState === 'running' && value.Status.State === 'running'); assert.ok(task);
    const ledger = JSON.parse(execFileSync('docker', ['exec', task.Status.ContainerStatus.ContainerID, 'node', '-e', `process.stdout.write(require('node:fs').readFileSync('/data/ledger.json','utf8'))`], { encoding: 'utf8', timeout: 10000 })); assert.deepEqual(ledger, [run + ':schema']);
    const consumerPath = join(path, 'consumers'); await mkdir(consumerPath, { mode: 0o700 }); consumerJournal = await openJournal(consumerPath);
    const consumerPorts = { ...artifacts, now: Date.now, authorize: async () => true, services: { ...ports.services, tombstone: serviceRuntime.tombstone }, readiness: { check: async () => { throw new Error('worker must not request routed readiness'); } } };
    let consumers = managedConsumerRollout(consumerJournal, consumerPorts); const consumerIntent = await consumers.prepare(plan, ready, null, []);
    await wait(async () => { const state = await consumers.tick(); assert.notEqual(state.phase, 'held'); return state.nodes[0]?.execution?.phase === 'observing'; }, consumerIntent.deadline, 'worker update acknowledgement');
    await consumerJournal.close(); consumerJournal = await openJournal(consumerPath, 'existing'); consumers = managedConsumerRollout(consumerJournal, consumerPorts);
    const consumerReady = await wait(async () => { const state = await consumers.tick(); assert.notEqual(state.phase, 'held'); return state.phase === 'ready' ? state : false; }, consumerIntent.deadline, 'reopened consumers');
    assert.equal(consumerReady.deadline, consumerIntent.deadline); assert.equal(JSON.stringify(await consumerJournal.read()).includes('synthetic-group-private-value'), false);
    const worker = consumerReady.nodes.find((node) => node.name === 'worker'); assert.equal(worker.ready.kind, 'running');
    const workerInspect = await api.request('GET', '/services/' + worker.ready.native.id); assert.equal(workerInspect.status, 200);
    assert.deepEqual(workerInspect.value.Spec.TaskTemplate.Networks.map((network) => network.Target), [grant.id]);
    const candidateChecked = parseManagedApplicationPlan({ ...plan, commit: 'f'.repeat(40), services: { ...plan.services, worker: { ...plan.services.worker, command: ['--eval', 'const release="candidate";process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'] } } }); assert.ok(candidateChecked.ok); const candidate = candidateChecked.value;
    const candidateAction = { app, service: 'worker', incarnation, dataOwner, action: incarnation + ':3', effect: 'apply', plan: managedServiceDigest(candidate.services.worker), deadline: Date.now() + 90000 };
    assert.ok(['acknowledged', 'uncertain'].includes(await serviceRuntime.apply(candidateAction, worker.ready.native, candidate.services.worker, serviceInputs(candidate.services.worker))));
    const candidateNative = await wait(async () => { const value = await serviceRuntime.observeDesired(candidateAction, candidate.services.worker, serviceInputs(candidate.services.worker)); return convergedService(candidateAction, value) ? value : false; }, candidateAction.deadline, 'candidate worker');
    const compensationPath = join(path, 'compensation'); await mkdir(compensationPath, { mode: 0o700 }); compensationJournal = await openJournal(compensationPath);
    let interruptRestore = true; const fenceTasks = [];
    const compensationPorts = { ...consumerPorts, services: { ...consumerPorts.services, apply: async (...args) => { if (interruptRestore) { interruptRestore = false; throw new Error('fixture interruption before restore transport'); } return consumerPorts.services.apply(...args); },
      fence: async (action, expected) => {
        const before = await serviceRuntime.observe({ app, service: 'worker', incarnation, dataOwner }); assert.equal(before.status, 'owned'); const ids = before.tasks.filter((task) => task.desired === 'running' && task.state === 'running').map((task) => task.id); assert.equal(ids.length, 1);
        const result = await serviceRuntime.fence(action, expected);
        const after = await wait(async () => { const value = await serviceRuntime.observe({ app, service: 'worker', incarnation, dataOwner }); return value.status === 'owned' && value.version > expected.version ? value : false; }, action.deadline, 'metadata fence');
        assert.deepEqual(after.tasks.filter((task) => task.desired === 'running' && task.state === 'running').map((task) => task.id), ids); fenceTasks.push(ids[0]); return result;
      } } };
    let compensation = managedServiceCompensation(compensationJournal, compensationPorts);
    const recovery = await compensation.prepare(candidate, plan, { ...candidateAction, plan: managedServiceDigest(plan.services.worker), effect: 'restore', deadline: Date.now() + 90000 }, worker.ready.native, [worker.ready.native, { id: candidateNative.id, version: candidateNative.version }]);
    await compensation.tick(); await compensation.tick(); const uncertain = await compensation.read(); assert.equal(uncertain.attempts[0].phase, 'observing');
    await compensationJournal.close(); compensationJournal = await openJournal(compensationPath, 'existing'); compensation = managedServiceCompensation(compensationJournal, compensationPorts);
    const restored = await wait(async () => { const state = await compensation.tick(); assert.notEqual(state.phase, 'held'); return state.phase === 'complete' ? state : false; }, recovery.action.deadline, 'reopened compensation');
    assert.equal(restored.action.deadline, recovery.action.deadline); assert.equal(restored.attempts.length, 2); assert.equal(restored.fences.length, 1); assert.equal(fenceTasks.length, 1);
    assert.equal(JSON.stringify(await compensationJournal.read()).includes('synthetic-group-private-value'), false);
    const cache = { ...plan.services.worker, service: 'cache', nativeName: managedServiceName(ownership, 'cache'), role: 'retained-dependency', inputs: inputs({}) };
    const extra = { ...plan.services.worker, service: 'extra', nativeName: managedServiceName(ownership, 'extra'), dependencies: [{ service: 'cache', condition: 'healthy' }] };
    const groupChecked = parseManagedApplicationPlan({ ...candidate, grants: { ...candidate.grants, memory_bytes: 1073741824, cpu_millicores: 1500 }, services: { ...candidate.services, cache, extra }, rollout: { ...candidate.rollout, migrations: [], services: { ...candidate.rollout.services, cache: { role: 'retained-dependency', overlap: 'forbidden' }, extra: { role: 'worker', overlap: 'forbidden' } } } }); assert.ok(groupChecked.ok); const groupPlan = groupChecked.value;
    const groupPath = join(path, 'whole-group'); await mkdir(groupPath, { mode: 0o700 });
    const preparePath = join(groupPath, 'preparation'); await mkdir(preparePath, { mode: 0o700 }); groupPreparationJournal = await openJournal(preparePath);
    const prepareGroup = managedGroupPreparation(groupPreparationJournal, ports); const groupRun = randomUUID(); const groupIntent = await prepareGroup.prepare(groupPlan, groupRun, incarnation + ':4', [{ name: 'db', kind: 'active', action: database.ready.action, native: database.ready.native }]);
    const groupPrefix = await wait(async () => { const value = await prepareGroup.tick(); assert.notEqual(value.phase, 'held'); return value.phase === 'ready' ? value : false; }, groupIntent.migrationDeadline, 'whole-group retained preparation');
    const consumePath = join(groupPath, 'consumers'); await mkdir(consumePath, { mode: 0o700 }); groupConsumerJournal = await openJournal(consumePath);
    const baseline = [{ name: 'worker', action: restored.attempts.at(-1).action, native: restored.proof.native }];
    const consumeGroup = managedConsumerRollout(groupConsumerJournal, consumerPorts); const forwardIntent = await consumeGroup.prepare(groupPlan, groupPrefix, plan, baseline);
    const groupForward = await wait(async () => { const value = await consumeGroup.tick(); assert.notEqual(value.phase, 'held'); return value.phase === 'ready' ? value : false; }, forwardIntent.deadline, 'whole-group consumer update');
    const recoverPath = join(groupPath, 'recovery'); await mkdir(recoverPath, { mode: 0o700 }); groupRecoveryJournal = await openJournal(recoverPath);
    const recoveryPorts = { ...consumerPorts, services: { ...consumerPorts.services, fence: serviceRuntime.fence } };
    let recoverGroup = managedGroupCompensation(groupRecoveryJournal, recoveryPorts); const groupRecoveryIntent = await recoverGroup.prepare({ candidate: groupPlan, previous: plan, preparation: groupPrefix, consumers: groupForward, baselines: baseline });
    await wait(async () => { const value = await recoverGroup.tick(); assert.notEqual(value.phase, 'held'); return value.nodes.find((node) => node.name === 'worker')?.child?.attempts.at(-1)?.phase === 'observing'; }, groupRecoveryIntent.deadline, 'whole-group restore acknowledgement');
    await groupRecoveryJournal.close(); groupRecoveryJournal = await openJournal(recoverPath, 'existing'); recoverGroup = managedGroupCompensation(groupRecoveryJournal, recoveryPorts);
    const recoveredGroup = await wait(async () => { const value = await recoverGroup.tick(); assert.notEqual(value.phase, 'held'); return value.phase === 'verified' ? value : false; }, groupRecoveryIntent.deadline, 'reopened whole-group recovery');
    assert.equal(recoveredGroup.deadline, groupRecoveryIntent.deadline); assert.equal(JSON.stringify(await groupRecoveryJournal.read()).includes('synthetic-group-private-value'), false);
    for (const name of ['cache', 'extra']) { const node = recoveredGroup.nodes.find((node) => node.name === name); assert.equal(node.child.phase, 'complete'); assert.equal(node.child.attempts.length, 0); const live = await serviceRuntime.observe({ app, service: name, incarnation, dataOwner }); assert.equal(live.status, 'owned'); assert.equal(live.replicas, 0); assert.equal(live.retainedInputsCleared, true); }
    await pause(200); finished = true; eventProcess.kill('SIGTERM'); await eventExit; assert.equal(eventError, undefined); assert.equal(partial, '');
    const migrationContainer = ready.sequence.steps[0].attempts[0].execution.container;
    const migrationStarts = events.filter((event) => event.Action === 'start' && event.Actor?.ID === migrationContainer).length; assert.equal(migrationStarts, 1);
    const dependencyStarts = events.filter((event) => event.Action === 'start' && event.Actor?.Attributes?.['com.docker.swarm.service.id'] === database.ready.native.id).length; assert.equal(dependencyStarts, 1);
    const workerStarts = events.filter((event) => event.Action === 'start' && event.Actor?.Attributes?.['com.docker.swarm.service.id'] === worker.ready.native.id).length; assert.equal(workerStarts, 5);
    const result = { passed: true, scope: 'fixture-authorized retained startup, private DNS migration, worker rollout, injected pre-transport restore interruption, metadata fencing, whole-group rollback and journal reopen; no indexed admission, SIGKILL, HTTP continuity, promotion or SQL acceptance', run, originalStartupDeadline: ready.startupDeadline, originalMigrationDeadline: ready.migrationDeadline,
      consumerDeadline: consumerReady.deadline, workerStarts, workerCandidateAndRestoreStarts: 4, wholeGroupRecovery: recoveredGroup.phase, wholeGroupOriginalDeadline: recoveredGroup.deadline, scrubbedNewOnlyServices: ['cache', 'extra'], compensationAttempts: restored.attempts.length, metadataFencePreservedTask: fenceTasks.length === 1, originalRecoveryDeadline: restored.action.deadline, workerPrivateOnly: true, dependencyStarts, migrationStarts, ledger, receipt, noSecretInJournal: true, node: process.version };
    await writeFile(join(path, 'result.json'), JSON.stringify(result, null, 2)); await writeFile(join(output, 'managed-group.json'), JSON.stringify(result, null, 2)); return result;
  } catch (error) { await writeFile(join(path, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack }, null, 2)); throw error; }
  finally {
    if (groupRecoveryJournal) await groupRecoveryJournal.close(); if (groupConsumerJournal) await groupConsumerJournal.close(); if (groupPreparationJournal) await groupPreparationJournal.close(); if (compensationJournal) await compensationJournal.close(); if (consumerJournal) await consumerJournal.close(); if (journal) await journal.close(); finished = true; eventProcess.kill('SIGTERM'); await eventExit;
    await writeFile(join(path, 'events.json'), JSON.stringify(events, null, 2)); await writeFile(join(path, 'requests.json'), JSON.stringify(requests, null, 2));
    await writeFile(join(path, 'event-observer.json'), JSON.stringify({ complete: eventError === undefined && partial === '', error: eventError ?? null }));
  }
};
