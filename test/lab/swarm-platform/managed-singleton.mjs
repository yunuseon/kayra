import { startManagedController } from '../../../cli/src/server/composition/managed-controller.ts';
import { managedRuntime } from '../../../cli/src/server/composition/managed-runtime.ts';
import { parseManagedExecutionContext } from '../../../cli/src/contracts/managed-execution-context.ts';
import { serviceInputValues } from '../../../cli/src/server/platform/service-inputs.ts';
// Application-owned graceful file-lock handoff. Kayra sees health and declared completion checks, never the lock protocol.
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseManagedApplicationPlan } from '../../../cli/src/contracts/managed-application-plan.ts';
import { managedServiceName } from '../../../cli/src/contracts/managed-service-plan.ts';
import { appOverlays } from '../../../cli/src/server/runtime/app-overlay.ts';
import { ownedVolumes } from '../../../cli/src/server/runtime/owned-volume.ts';
import { managedSwarmService } from '../../../cli/src/server/runtime/managed-swarm-service.ts';
import { containerChecks } from '../../../cli/src/server/runtime/container-check.ts';
import { managedLifecycleDescription, managedLifecycleSourceDigest, parseManagedLifecycleSource } from '../../../cli/src/server/deployment/managed-lifecycle-source.ts';
import { parseManagedRelease } from '../../../cli/src/server/deployment/managed-release.ts';
import { createLifecycleAppIndex, openLifecycleAppIndex } from '../../../cli/src/server/deployment/lifecycle-app-index.ts';
import { observeSwarmHost } from '../../../cli/src/server/runtime/swarm-host.ts';
import { openJournal } from '../../../cli/src/server/deployment/journal.ts';
import { openArtifactStore } from '../../../cli/src/server/deployment/artifact-store.ts';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (check, deadline, description) => { while (Date.now() < deadline) { const result = await check(); if (result) return result; await pause(100); } throw new Error('singleton fixture deadline: ' + description); };
export const probeManagedSingleton = async (app, image, api, routingNetwork, swarm, output) => {
  const path = join(output, 'managed-singleton'); await mkdir(path, { mode: 0o700 }); const indexDirectory = join(path, 'app-index'); let index, currentRun, managedController; let lostSettlement = false, lostUnstartedSettlement = false;
  const observer = async (expected) => ({ ...expected, status: 'applied' });
  const journals = async (directory, mode) => { const base = await openJournal(directory, mode); return { ...base, write: async (value) => {
    await base.write(value);
    if (directory === indexDirectory) { const binding = value.managedBindings?.find((item) => item.owner.app === app); const charge = value.resources?.charges.find((item) => item.app === app); const sequence = Number(binding?.action.split(':')[1]);
      if (charge?.result === 'previous' && sequence === 3 && !lostSettlement) { lostSettlement = true; throw new Error('fixture lost indexed previous-settlement acknowledgement'); }
      if (charge?.result === 'previous' && sequence >= 4 && !lostUnstartedSettlement) { lostUnstartedSettlement = true; throw new Error('fixture lost indexed unstarted-settlement acknowledgement'); }
    }
  } }; };
  try {
    index = await createLifecycleAppIndex(indexDirectory, observer, journals); const incarnation = await index.prepareApp(app, 'managed-v3'); const generation = randomUUID(); const ticket = await index.reserveRegistration(app, generation, 'swarm'); await index.submitRegistration(app, ticket, generation); assert.equal((await index.reconcileRegistration(app, ticket, generation)).status, 'verified');
    const registration = await index.verifiedRegistration(app); const ownership = await index.dataOwnership(app); const dataOwner = ownership.dataOwner;
    const scope = { version: 1, app, incarnation, node: swarm.NodeID, cluster: swarm.Cluster.ID, name: 'kayra-app-' + incarnation }; const overlays = appOverlays(api); const deadline = Date.now() + 90000;
    assert.ok(['acknowledged', 'uncertain'].includes(await overlays.create({ scope, operation: randomUUID(), deadline })));
    const overlay = await wait(async () => { const value = await overlays.observe(scope); return value.status === 'owned' ? value.grant : false; }, deadline, 'overlay');
    const allocation = { value: (await index.reserveDataVolumeIdentities(app, ['coordination']))[0] }; assert.ok(allocation.value); const volumes = ownedVolumes(api);
    const code = `const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');const owner=crypto.randomUUID(),release=process.env.RELEASE,lock='/data/owner',history='/data/history';let held=false,closing=false,standby=false;const emit=event=>{const fd=fs.openSync(history,'a');fs.writeSync(fd,JSON.stringify({event,owner,release,at:Date.now()})+String.fromCharCode(10));fs.fsyncSync(fd);fs.closeSync(fd)};const tick=()=>{if(closing)return;if(!held){try{const fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,owner);fs.fsyncSync(fd);fs.closeSync(fd);held=true;emit('acquired')}catch(e){if(e.code!=='EEXIST')throw e;if(!standby){standby=true;emit('standby')}}}if(held)emit('effect')};tick();const timer=setInterval(tick,100);const server=http.createServer((req,res)=>{if(req.url==='/active')res.statusCode=held?200:503;if(req.url==='/history')res.end(fs.readFileSync(history,'utf8'));else res.end(JSON.stringify({healthy:true,active:held,owner,release}))}).listen(8081,'0.0.0.0');process.on('SIGTERM',()=>{closing=true;clearInterval(timer);if(held){emit('released');if(fs.readFileSync(lock,'utf8')===owner)fs.unlinkSync(lock);held=false}server.close(()=>setTimeout(()=>{emit('exiting');process.exit(0)},3000));setTimeout(()=>process.exit(1),5000).unref()});`;
    const check = ['node', '--eval', `fetch('http://127.0.0.1:8081/active',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`];
    const spec = { version: 1, runtime: 'swarm', owner: ownership, service: 'leader', nativeName: managedServiceName(ownership, 'leader'), role: 'singleton', overlap: 'coordinated', handoffCheck: 'active', image,
      inputs: { version: 1, registration, configurationIdentity: 'sha256:' + 'c'.repeat(64), environment: { RELEASE: { kind: 'literal', value: 'A' } } }, command: ['--eval', code], entrypoint: ['node'],
      resources: { memoryBytes: 134217728, reserveMemoryBytes: 67108864, nanoCpus: 250000000, reserveNanoCpus: 125000000 }, health: { command: ['node', '--eval', `fetch('http://127.0.0.1:8081/health',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`], intervalSeconds: 2, timeoutSeconds: 2, startPeriodSeconds: 1, retries: 3 }, stopGraceSeconds: 30,
      host: { node: swarm.NodeID, cluster: swarm.Cluster.ID, routingNetwork: null }, privateNetwork: { id: overlay.id, name: overlay.scope.name }, mounts: [{ volume: allocation.value, target: '/data', readOnly: false, noCopy: true }], dependencies: [] };
    const artifacts = await openArtifactStore(join(path, 'artifacts'));
    const builds = { ...artifacts, now: Date.now, prepare: async (_registration, commit) => JSON.stringify({ fixture: 'indexed-native-singleton', registration, commit, image }), images: () => [image] };
    const buildA = await index.prepareBuild(app, 'a'.repeat(40), builds);
    const initial = parseManagedApplicationPlan({ version: 3, runtime: 'swarm', infrastructure: { version: 1, runtime: 'swarm', registration, ownership, overlay }, commit: 'a'.repeat(40), artifact: buildA.artifact, configurationIdentity: 'sha256:' + 'c'.repeat(64),
      host: { version: 1, node: swarm.NodeID, cluster: swarm.Cluster.ID, network: { name: 'platform-swarm', id: routingNetwork }, profile: { enabled: true, advertise_address: swarm.NodeAddr, memory_bytes: 3221225472, cpu_millicores: 2000, platform_memory_bytes: 1073741824, platform_cpu_millicores: 500 } },
      grants: { memory_bytes: 536870912, cpu_millicores: 750, maintenance: false }, hosts: [], secrets: [], routes: [], rollout: { strategy: 'rolling', mixed_version_compatible: true, rollback_compatible: true, services: { leader: { role: 'singleton', overlap: 'coordinated', handoff_check: 'active' } }, migrations: [], checks: [{ id: 'active', service: 'leader', command: check, timeout_seconds: 10 }] },
      policy: { version: 1, failureMonitorSeconds: 30, updateTimeoutSeconds: 90, rollbackTimeoutSeconds: 90, migrationTimeoutCeilingSeconds: 90, checkTimeoutCeilingSeconds: 90 }, images: [{ source: image, pull: image, os: 'linux', architecture: process.arch === 'x64' ? 'amd64' : process.arch }], services: { leader: spec },
    }); assert.ok(initial.ok, initial.ok ? '' : initial.error); const planA = initial.value;
    let creationCalls = 0;
    let lostCreation = false;
    const creationPorts = { native: { observe: volumes.observe, create: async (action) => { creationCalls++; const result = await volumes.create(action); if (!lostCreation) { lostCreation = true; throw new Error('fixture lost native volume creation acknowledgement'); } return result; } }, now: Date.now };
    const recorded = { read: (references) => index.recordedManagedVolumes(app, references) };
    const native = managedSwarmService(api, volumes); const checks = containerChecks(api);
    const runtimeFor = (context) => managedRuntime(context, { ...artifacts, now: Date.now, observeHost: (host) => observeSwarmHost(host, api),
      environment: serviceInputValues((reference) => Promise.resolve({ configurationIdentity: reference.configurationIdentity, configuration: {}, secrets: {}, secretKeys: [] })), receipts: recorded,
      authority: { allowed: async (context) => context.application.host.node === swarm.NodeID && context.owner.incarnation === incarnation && context.owner.dataOwner === dataOwner && context.application.images.every((item) => item.pull === image) },
      native: { services: native, volumes: creationPorts.native, checks, jobs: { observe: async () => ({ status: 'unavailable' }), create: async () => 'refused', start: async () => 'refused', fence: async () => 'refused' }, readiness: { check: async () => { throw new Error('singleton must not request routed readiness'); } } },
    });
    const contextFor = (source) => { const description = managedLifecycleDescription(source); const checked = parseManagedExecutionContext({ version: 1, protocol: 'managed-v3', runtime: 'swarm', owner: ownership, run: source.run, action: source.action, source: managedLifecycleSourceDigest(source), application: source.candidate, previous: source.previous?.source.application ?? null, allocationRequired: source.version === 2, createdAt: source.createdAt, admissionDeadline: description.admissionDeadline, deadline: description.deadline }); assert.ok(checked.ok); return checked.value; };
    let ports;
    const lifecycle = { read: () => index.managedState(app, ports), cancel: () => index.cancelManagedDeployment(app, currentRun, ports), begin: async (input) => { const source = parseManagedLifecycleSource(input); ports = runtimeFor(contextFor(source)); await index.requestManagedDeployment(app, source, ports); currentRun = source.run; return index.managedState(app, ports); }, tick: () => index.tickManagedDeployment(app, currentRun, ports) };
    const reopen = async () => { await index.close(); index = await openLifecycleAppIndex(indexDirectory, observer, journals); const pending = await index.pendingManagedDeployments(); if (pending.length > 0) { assert.equal(pending.length, 1); assert.equal(pending[0].run, currentRun); } };
    const proposalInputs = serviceInputValues((reference) => Promise.resolve({ configurationIdentity: reference.configurationIdentity, configuration: {}, secrets: {}, secretKeys: [] }));
    const proposalPorts = { ...artifacts, now: Date.now, compare: proposalInputs.compare };
    const aSource = await index.proposeManagedDeployment(app, planA, randomUUID(), proposalPorts); assert.equal(aSource.previous, null); assert.equal(aSource.action, incarnation + ':2');
    const aIntent = await lifecycle.begin(aSource);
    assert.equal(creationCalls, 0); let allocationReopened = false, allocationDeadline, reconstructedObserverInputs = 0;
    const a = await wait(async () => { const value = allocationReopened ? await lifecycle.read() : await lifecycle.tick(); assert.notEqual(value.operation.phase, 'held');
      if (creationCalls === 1 && !allocationReopened) { assert.equal(value.operation.phase, 'allocating'); assert.equal((await index.resourceSnapshot()).charges[0].result, 'pending'); allocationDeadline = value.operation.allocation.deadline; await reopen(); allocationReopened = true;
        managedController = startManagedController(index, { ...artifacts, now: Date.now, forRun: (context) => { assert.equal(context.run, aIntent.operation.run); assert.equal(context.source, aIntent.operation.source); assert.equal(context.deadline, aIntent.operation.deadline); assert.equal(context.allocationRequired, true); reconstructedObserverInputs++; return Promise.resolve(runtimeFor(context)); } }, () => undefined, 100);
      }
      return value.operation.phase === 'complete' ? value : false;
    }, aIntent.operation.deadline, 'complete A');
    await managedController.close(); assert.ok(reconstructedObserverInputs > 0);
    assert.ok(allocationReopened); assert.equal(a.operation.allocation.deadline, allocationDeadline); assert.ok(a.operation.allocation.readyAt); const [receipt] = await recorded.read([allocation.value]); assert.ok(receipt);
    const initialHealth = await index.managedDeploymentHealth(app, ports); assert.equal(initialHealth.state, 'available');
    const initialStatus = await index.managedDeploymentStatus(app, ports); assert.equal(initialStatus.verifiedActive.run, aIntent.operation.run); assert.equal(initialStatus.runtimeObservation, 'not-observed');
    const previous = parseManagedRelease(JSON.parse(await artifacts.read(a.active.record)));
    const buildB = await index.prepareBuild(app, 'b'.repeat(40), builds);
    const candidate = parseManagedApplicationPlan({ ...planA, commit: 'b'.repeat(40), artifact: buildB.artifact, services: { leader: { ...planA.services.leader, inputs: { ...planA.services.leader.inputs, environment: { RELEASE: { kind: 'literal', value: 'B' } } } } }, rollout: { ...planA.rollout, checks: [{ id: 'active', service: 'leader', command: ['node', '--eval', 'process.exit(1)'], timeout_seconds: 10 }] } }); assert.ok(candidate.ok); const planB = candidate.value;
    const bSource = await index.proposeManagedDeployment(app, planB, randomUUID(), proposalPorts); assert.deepEqual(bSource.previous, previous); assert.equal(bSource.action, incarnation + ':3');
    const bIntent = await lifecycle.begin(bSource);
    const b = await wait(async () => { const value = await lifecycle.tick(); return value.operation.phase === 'held' ? value : false; }, bIntent.operation.deadline, 'failed candidate check'); assert.equal(b.operation.verification.reason, 'check-failed'); assert.equal(b.active.record, a.active.record);
    const heldHealth = await index.managedDeploymentHealth(app, ports); assert.equal(heldHealth.state, 'available'); const heldStatus = await index.managedDeploymentStatus(app, ports); assert.equal(heldStatus.requiredAction, 'inspect-and-resolve'); assert.equal(heldStatus.verifiedActive.run, aIntent.operation.run);
    await reopen(); const recoveryIntent = await lifecycle.tick(); assert.equal(recoveryIntent.operation.phase, 'recovering'); assert.ok(recoveryIntent.operation.recoveryDeadline); await reopen();
    await wait(async () => { const value = await lifecycle.tick(); assert.notEqual(value.operation.phase, 'held'); return value.operation.recovery?.nodes.some((node) => node.child?.attempts.at(-1)?.phase === 'observing'); }, recoveryIntent.operation.recoveryDeadline, 'restore update acknowledgement'); await reopen();
    const promoted = await wait(async () => { const value = await lifecycle.tick(); assert.notEqual(value.operation.phase, 'held'); return value.operation.phase === 'settling' ? value : false; }, bIntent.operation.deadline, 'verified restoration promotion');
    assert.equal(promoted.operation.outcome, 'rolled-back'); assert.equal(promoted.operation.settlement, 'previous'); assert.equal(promoted.active.plan, a.active.plan); assert.notEqual(promoted.active.record, a.active.record); assert.equal(promoted.active.run, bIntent.operation.run); assert.equal(promoted.operation.plan, bIntent.operation.plan);
    await lifecycle.tick(); assert.equal(lostSettlement, true); assert.equal((await lifecycle.read()).operation.phase, 'settling'); await reopen(); const done = await lifecycle.tick(); assert.equal(done.operation.phase, 'complete'); assert.equal(done.operation.recoveryDeadline, recoveryIntent.operation.recoveryDeadline); assert.equal((await index.resourceSnapshot()).charges[0].result, 'previous');
    const restored = done.operation.recovery, verified = done.operation.recoveryVerification; assert.notEqual(verified.checkRun, verified.run); assert.equal(verified.phase, 'verified'); assert.deepEqual(done.active, done.lastGood);
    const current = await native.observe({ app, incarnation, dataOwner, service: 'leader' }); assert.equal(current.status, 'owned'); const task = current.tasks.find((task) => task.desired === 'running' && task.state === 'running'); assert.ok(task);
    const selected = await checks.select(restored.nodes[0].child.attempts.at(-1).action, verified.verified.observations[0].native, task.id); assert.equal(selected.status, 'owned');
    const text = execFileSync('docker', ['exec', selected.target.container, 'node', '--eval', `fetch('http://127.0.0.1:8081/history').then(async r=>process.stdout.write(await r.text())).catch(()=>process.exit(1))`], { encoding: 'utf8', timeout: 10000 }); const history = text.trim().split('\n').map((line) => JSON.parse(line)); let leaderOwner = null;
    for (const event of history) { if (event.event === 'acquired') { assert.equal(leaderOwner, null); leaderOwner = event.owner; } else if (event.event === 'released') { assert.equal(leaderOwner, event.owner); leaderOwner = null; } else if (event.event === 'effect') assert.equal(leaderOwner, event.owner); }
    assert.deepEqual(history.filter((event) => event.event === 'acquired').map((event) => event.release), ['A', 'B', 'A']); assert.ok(history.some((event) => event.event === 'standby' && event.release === 'B')); assert.ok(leaderOwner);
    const exitingA = history.find((event) => event.event === 'exiting' && event.release === 'A'); const exitingB = history.find((event) => event.event === 'exiting' && event.release === 'B'); assert.ok(exitingA && exitingB); assert.ok(b.operation.consumers.verifiedAt >= exitingA.at); assert.ok(restored.verifiedAt >= exitingB.at);
    const restoredHealth = await index.managedDeploymentHealth(app, ports); assert.equal(restoredHealth.state, 'available'); const restoredStatus = await index.managedDeploymentStatus(app, ports); assert.equal(restoredStatus.operation.outcome, 'rolled-back'); assert.equal(restoredStatus.verifiedActive.run, bIntent.operation.run);
    const restoredRelease = parseManagedRelease(JSON.parse(await artifacts.read(done.active.record)));
    for (const reserved of [false, true]) {
      const cancelledSource = await index.proposeManagedDeployment(app, planB, randomUUID(), proposalPorts); assert.deepEqual(cancelledSource.previous, restoredRelease); assert.equal(cancelledSource.action, incarnation + (reserved ? ':5' : ':4'));
      await lifecycle.begin(cancelledSource); if (reserved) await lifecycle.tick(); await lifecycle.cancel();
      const cancellation = await lifecycle.tick(); assert.equal(cancellation.operation.phase, 'settling'); assert.ok(cancellation.operation.unstartedAt); assert.equal(cancellation.operation.preparation, null); await reopen();
      await lifecycle.tick(); await reopen(); const completed = await lifecycle.tick(); assert.equal(completed.operation.phase, 'complete'); assert.equal(completed.operation.outcome, 'unchanged'); assert.deepEqual(completed.active, done.active);
      const status = await index.managedDeploymentStatus(app, ports); assert.equal(status.operation.outcome, 'unchanged'); assert.deepEqual(status.verifiedActive, restoredStatus.verifiedActive); assert.equal((await index.managedDeploymentHealth(app, ports)).state, 'available');
      const unchanged = await native.observe({ app, incarnation, dataOwner, service: 'leader' }); assert.equal(unchanged.status, 'owned'); assert.equal(unchanged.version, current.version); assert.deepEqual(unchanged.tasks.map((task) => task.id), current.tasks.map((task) => task.id)); assert.equal((await index.resourceSnapshot()).charges[0].result, 'previous');
    }
    assert.deepEqual(await recorded.read([allocation.value]), [receipt]); assert.equal(creationCalls, 1);
    const shared = JSON.parse(await readFile(join(indexDirectory, createHash('sha256').update(app).digest('hex'), 'state.json'), 'utf8')); assert.equal(shared.operations.length, 0); assert.equal(shared.managed.length, 4); assert.deepEqual(shared.managed.map((item) => item.action), [2, 3, 4, 5].map((sequence) => incarnation + ':' + sequence)); assert.equal(shared.fence.nextAction, 6);
    const result = { passed: true, indexedCoordinatorBuiltProposal: true, composedManagedRuntime: true, managedObserverRestartReconstruction: true, reconstructedObserverInputs, indexOwnedVolumeCatalog: true, admittedVolumeAllocation: true, allocationLostAcknowledgementReopened: allocationReopened, allocationOriginalDeadline: allocationDeadline, volumeCreationCatalog: true, catalogRecordedBirthReused: true, volumeCreationCalls: creationCalls, recordedVolumeReceiptReader: true, durableVolumeCreationReceipt: true, composedWorkloadInputs: true, managedHealthProjection: true, managedStatusProjection: true, historicalCertificationSeparateFromCurrentAvailability: true, indexedManagedLifecycle: true, sharedAccountingWriter: true, sharedLifecycleGate: true, sharedLifecycleRequestCount: shared.managed.length, sharedActionSequenceBound: true, scope: 'composed managed runtime with index-owned catalog and reconstructed observer after lost native creation acknowledgement, using immutable per-run inputs; filesystem app index, shared accounting and lifecycle gate with fixture build/grant callbacks; graceful app-owned singleton handoff, checks and journal reopen; no public builder/CLI wiring, exactly-once, SIGKILL or host-loss guarantee', lifecycleOwner: true, unstartedCancellationReservedAndUnreserved: true, unstartedLostAcknowledgementRecovered: true, unstartedNativeVersionAndTasksUnchanged: true, outcome: done.operation.outcome, restoredActiveRun: done.active.run, lostSettlementAcknowledgementRecovered: true, restoreAcknowledgementReopened: true, originalRecoveryDeadline: done.operation.recoveryDeadline, incarnation, service: current.id, candidateCheck: b.operation.verification.reason, restoredCheck: verified.phase, distinctRecoveryCheckIdentity: verified.checkRun !== verified.run, candidateConvergedAfterOldExit: true, restoredConvergedAfterCandidateExit: true, gracefulExitDelayMs: 3000, acquiredReleases: ['A', 'B', 'A'], standbyObserved: true, effects: history.filter((event) => event.event === 'effect').length, receipt };
    await writeFile(join(path, 'history.json'), JSON.stringify(history, null, 2)); await writeFile(join(path, 'result.json'), JSON.stringify(result, null, 2)); await writeFile(join(output, 'managed-singleton.json'), JSON.stringify(result, null, 2)); return result;
  } catch (error) { await writeFile(join(path, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack }, null, 2)); throw error; }
  finally { try { if (managedController !== undefined) await managedController.close(); } finally { if (index !== undefined) await index.close(); } }
};
