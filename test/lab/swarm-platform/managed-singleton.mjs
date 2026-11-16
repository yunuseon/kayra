// Application-owned graceful file-lock handoff. Kayra sees health and declared completion checks, never the lock protocol.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseManagedApplicationPlan } from '../../../cli/src/contracts/managed-application-plan.ts';
import { managedServiceName } from '../../../cli/src/contracts/managed-service-plan.ts';
import { ownedVolume } from '../../../cli/src/contracts/owned-volume.ts';
import { appOverlays } from '../../../cli/src/server/runtime/app-overlay.ts';
import { ownedVolumes } from '../../../cli/src/server/runtime/owned-volume.ts';
import { managedSwarmService } from '../../../cli/src/server/runtime/managed-swarm-service.ts';
import { containerChecks } from '../../../cli/src/server/runtime/container-check.ts';
import { managedGroupPreparation } from '../../../cli/src/server/deployment/managed-group-preparation.ts';
import { managedConsumerRollout } from '../../../cli/src/server/deployment/managed-consumer-rollout.ts';
import { managedGroupVerification } from '../../../cli/src/server/deployment/managed-group-verification.ts';
import { managedGroupCompensation } from '../../../cli/src/server/deployment/managed-group-compensation.ts';
import { openJournal } from '../../../cli/src/server/deployment/journal.ts';
import { openArtifactStore } from '../../../cli/src/server/deployment/artifact-store.ts';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (check, deadline, description) => { while (Date.now() < deadline) { const result = await check(); if (result) return result; await pause(100); } throw new Error('singleton fixture deadline: ' + description); };
export const probeManagedSingleton = async (app, image, api, routingNetwork, swarm, output) => {
  const path = join(output, 'managed-singleton'); await mkdir(path, { mode: 0o700 }); const journals = [];
  const journal = async (name) => { const directory = join(path, name); await mkdir(directory, { mode: 0o700 }); const value = await openJournal(directory); journals.push(value); return value; };
  try {
    const incarnation = randomUUID(); const dataOwner = randomUUID(); const registration = { version: 1, app, incarnation, actionId: incarnation + ':1', registrationGeneration: randomUUID() }; const ownership = { version: 1, app, incarnation, dataOwner };
    const scope = { version: 1, app, incarnation, node: swarm.NodeID, cluster: swarm.Cluster.ID, name: 'kayra-app-' + incarnation }; const overlays = appOverlays(api); const deadline = Date.now() + 90000;
    assert.ok(['acknowledged', 'uncertain'].includes(await overlays.create({ scope, operation: randomUUID(), deadline })));
    const overlay = await wait(async () => { const value = await overlays.observe(scope); return value.status === 'owned' ? value.grant : false; }, deadline, 'overlay');
    const allocation = ownedVolume(app, dataOwner, randomUUID(), 'coordination'); assert.ok(allocation.ok); const volumes = ownedVolumes(api); assert.ok(['acknowledged', 'uncertain'].includes(await volumes.create({ volume: allocation.value, operation: randomUUID(), deadline })));
    const volume = await volumes.observe(allocation.value); assert.equal(volume.status, 'owned'); const receipt = volume.receipt;
    const code = `const fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto');const owner=crypto.randomUUID(),release=process.env.RELEASE,lock='/data/owner',history='/data/history';let held=false,closing=false,standby=false;const emit=event=>{const fd=fs.openSync(history,'a');fs.writeSync(fd,JSON.stringify({event,owner,release,at:Date.now()})+'\\n');fs.fsyncSync(fd);fs.closeSync(fd)};const tick=()=>{if(closing)return;if(!held){try{const fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,owner);fs.fsyncSync(fd);fs.closeSync(fd);held=true;emit('acquired')}catch(e){if(e.code!=='EEXIST')throw e;if(!standby){standby=true;emit('standby')}}}if(held)emit('effect')};tick();const timer=setInterval(tick,100);const server=http.createServer((req,res)=>{if(req.url==='/active')res.statusCode=held?200:503;if(req.url==='/history')res.end(fs.readFileSync(history,'utf8'));else res.end(JSON.stringify({healthy:true,active:held,owner,release}))}).listen(8081,'0.0.0.0');process.on('SIGTERM',()=>{closing=true;clearInterval(timer);if(held){emit('released');if(fs.readFileSync(lock,'utf8')===owner)fs.unlinkSync(lock);held=false}server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref()});`;
    const check = ['node', '--eval', `fetch('http://127.0.0.1:8081/active',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`];
    const spec = { version: 1, runtime: 'swarm', owner: ownership, service: 'leader', nativeName: managedServiceName(ownership, 'leader'), role: 'singleton', overlap: 'coordinated', handoffCheck: 'active', image,
      inputs: { version: 1, registration, configurationIdentity: 'sha256:' + 'c'.repeat(64), environment: { RELEASE: { kind: 'literal', value: 'A' } } }, command: ['--eval', code], entrypoint: ['node'],
      resources: { memoryBytes: 134217728, reserveMemoryBytes: 67108864, nanoCpus: 250000000, reserveNanoCpus: 125000000 }, health: { command: ['node', '--eval', `fetch('http://127.0.0.1:8081/health',{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`], intervalSeconds: 1, timeoutSeconds: 2, startPeriodSeconds: 1, retries: 3 }, stopGraceSeconds: 30,
      host: { node: swarm.NodeID, cluster: swarm.Cluster.ID, routingNetwork: null }, privateNetwork: { id: overlay.id, name: overlay.scope.name }, mounts: [{ volume: allocation.value, target: '/data', readOnly: false, noCopy: true }], dependencies: [] };
    const initial = parseManagedApplicationPlan({ version: 3, runtime: 'swarm', infrastructure: { version: 1, runtime: 'swarm', registration, ownership, overlay }, commit: 'a'.repeat(40), artifact: 'e'.repeat(64), configurationIdentity: 'sha256:' + 'c'.repeat(64),
      host: { version: 1, node: swarm.NodeID, cluster: swarm.Cluster.ID, network: { name: 'platform-swarm', id: routingNetwork }, profile: { enabled: true, advertise_address: swarm.NodeAddr, memory_bytes: 3221225472, cpu_millicores: 2000, platform_memory_bytes: 1073741824, platform_cpu_millicores: 500 } },
      grants: { memory_bytes: 536870912, cpu_millicores: 750, maintenance: false }, hosts: [], secrets: [], routes: [], rollout: { strategy: 'rolling', mixed_version_compatible: true, rollback_compatible: true, services: { leader: { role: 'singleton', overlap: 'coordinated', handoff_check: 'active' } }, migrations: [], checks: [{ id: 'active', service: 'leader', command: check, timeout_seconds: 10 }] },
      policy: { version: 1, failureMonitorSeconds: 30, updateTimeoutSeconds: 90, rollbackTimeoutSeconds: 90, migrationTimeoutCeilingSeconds: 90, checkTimeoutCeilingSeconds: 90 }, images: [{ source: image, pull: image, os: 'linux', architecture: process.arch === 'x64' ? 'amd64' : process.arch }], services: { leader: spec },
    }); assert.ok(initial.ok, initial.ok ? '' : initial.error); const planA = initial.value;
    const artifacts = await openArtifactStore(join(path, 'artifacts')); const native = managedSwarmService(api, volumes); const checks = containerChecks(api);
    const inputs = (service) => ({ environment: Object.fromEntries(Object.entries(service.inputs.environment).map(([key, binding]) => { assert.equal(binding.kind, 'literal'); return [key, binding.value]; })), routing: {}, volumes: [receipt] });
    const ports = { ...artifacts, now: Date.now, authorize: async () => true, checks, services: { observe: native.observe, observeDesired: (action, service) => native.observeDesired(action, service, inputs(service)), apply: (action, expected, service) => native.apply(action, expected, service, inputs(service)), reactivate: (action, expected, service) => native.reactivate(action, expected, service, inputs(service)), tombstone: native.tombstone, fence: native.fence },
      jobs: { observe: async () => ({ status: 'unavailable' }), create: async () => 'refused', start: async () => 'refused', fence: async () => 'refused' }, readiness: { check: async () => { throw new Error('singleton must not request routed readiness'); } } };
    const deploy = async (plan, sequence, previous, baselines) => {
      const prep = managedGroupPreparation(await journal('prepare-' + sequence), ports); const intent = await prep.prepare(plan, randomUUID(), incarnation + ':' + sequence, []);
      const prefix = await wait(async () => { const value = await prep.tick(); assert.notEqual(value.phase, 'held'); return value.phase === 'ready' ? value : false; }, intent.migrationDeadline, 'preparation');
      const consume = managedConsumerRollout(await journal('consume-' + sequence), ports); const update = await consume.prepare(plan, prefix, previous, baselines);
      const consumers = await wait(async () => { const value = await consume.tick(); assert.notEqual(value.phase, 'held'); return value.phase === 'ready' ? value : false; }, update.deadline, 'native singleton convergence');
      const verify = managedGroupVerification(await journal('verify-' + sequence), ports); const verification = await verify.prepare({ kind: 'deployment', application: plan, certificate: consumers });
      const result = await wait(async () => { const value = await verify.tick(); return value.phase !== 'running' ? value : false; }, verification.deadline, 'completion check');
      return { prefix, consumers, result };
    };
    const a = await deploy(planA, 2, null, []); assert.equal(a.result.phase, 'verified'); const leaderA = a.consumers.nodes.find((node) => node.name === 'leader'); assert.ok(leaderA.ready);
    const candidate = parseManagedApplicationPlan({ ...planA, commit: 'b'.repeat(40), artifact: 'f'.repeat(64), services: { leader: { ...planA.services.leader, inputs: { ...planA.services.leader.inputs, environment: { RELEASE: { kind: 'literal', value: 'B' } } } } }, rollout: { ...planA.rollout, checks: [{ id: 'active', service: 'leader', command: ['node', '--eval', 'process.exit(1)'], timeout_seconds: 10 }] } }); assert.ok(candidate.ok); const planB = candidate.value;
    const baseline = [{ name: 'leader', action: leaderA.ready.action, native: leaderA.ready.native }]; const b = await deploy(planB, 3, planA, baseline); assert.equal(b.result.phase, 'held'); assert.equal(b.result.reason, 'check-failed'); assert.equal(b.result.verified, null);
    const recoveryJournal = await journal('recovery'); const recovery = managedGroupCompensation(recoveryJournal, ports); const recoveryIntent = await recovery.prepare({ candidate: planB, previous: planA, preparation: b.prefix, consumers: b.consumers, baselines: baseline });
    const restored = await wait(async () => { const value = await recovery.tick(); assert.notEqual(value.phase, 'held'); return value.phase === 'verified' ? value : false; }, recoveryIntent.deadline, 'restore A');
    const rootSource = await recoveryJournal.read(); const sourceBytes = await artifacts.read(rootSource.source); const source = JSON.parse(sourceBytes);
    const verify = managedGroupVerification(await journal('verify-restored'), ports); const verifyIntent = await verify.prepare({ kind: 'recovery', application: planA, certificate: restored, recoverySource: source });
    const verified = await wait(async () => { const value = await verify.tick(); assert.notEqual(value.phase, 'held'); return value.phase === 'verified' ? value : false; }, verifyIntent.deadline, 'restored completion check'); assert.notEqual(verified.checkRun, verified.run);
    const current = await native.observe({ app, incarnation, dataOwner, service: 'leader' }); assert.equal(current.status, 'owned'); const task = current.tasks.find((task) => task.desired === 'running' && task.state === 'running'); assert.ok(task);
    const selected = await checks.select(restored.nodes[0].child.attempts.at(-1).action, verified.verified.observations[0].native, task.id); assert.equal(selected.status, 'owned');
    const text = execFileSync('docker', ['exec', selected.target.container, 'node', '--eval', `fetch('http://127.0.0.1:8081/history').then(async r=>process.stdout.write(await r.text())).catch(()=>process.exit(1))`], { encoding: 'utf8', timeout: 10000 }); const history = text.trim().split('\n').map((line) => JSON.parse(line)); let owner = null;
    for (const event of history) { if (event.event === 'acquired') { assert.equal(owner, null); owner = event.owner; } else if (event.event === 'released') { assert.equal(owner, event.owner); owner = null; } else if (event.event === 'effect') assert.equal(owner, event.owner); }
    assert.deepEqual(history.filter((event) => event.event === 'acquired').map((event) => event.release), ['A', 'B', 'A']); assert.ok(history.some((event) => event.event === 'standby' && event.release === 'B')); assert.ok(owner);
    const result = { passed: true, scope: 'fixture-authorized graceful application-owned file-lock handoff and declared completion checks; no indexed promotion, exactly-once, lease expiry, SIGKILL or host-loss guarantee', incarnation, service: current.id, candidateCheck: b.result.reason, restoredCheck: verified.phase, distinctRecoveryCheckIdentity: verified.checkRun !== verified.run, acquiredReleases: ['A', 'B', 'A'], standbyObserved: true, effects: history.filter((event) => event.event === 'effect').length, receipt };
    await writeFile(join(path, 'history.json'), JSON.stringify(history, null, 2)); await writeFile(join(path, 'result.json'), JSON.stringify(result, null, 2)); await writeFile(join(output, 'managed-singleton.json'), JSON.stringify(result, null, 2)); return result;
  } catch (error) { await writeFile(join(path, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack }, null, 2)); throw error; }
  finally { for (const item of journals) await item.close(); }
};
