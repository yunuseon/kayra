// Native reserved-action cleanup and verified successor handoff.
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManagedApplicationPlan } from '../../../cli/src/contracts/managed-application-plan.ts';
import { managedPlatform } from '../../../cli/src/server/composition/managed-platform.ts';
import { managedForwardCleanupRuntime } from '../../../cli/src/server/composition/managed-forward-cleanup-runtime.ts';
import { checkContainerFences } from '../../../cli/src/server/runtime/check-container-fence.ts';
import { ownedVolumes } from '../../../cli/src/server/runtime/owned-volume.ts';
import { observeSwarmHost } from '../../../cli/src/server/runtime/swarm-host.ts';
import { oneShotJob } from '../../../cli/src/server/runtime/one-shot-job.ts';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (check, deadline, description) => { while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(100); } throw new Error('forward cleanup fixture deadline: ' + description); };
export const probeManagedForwardSingleton = async ({ app, image, api, swarm, incarnation, dataOwner, path, planA, builds, proposalPorts, lifecycle, reopen, currentIndex, native, allocation, receipt, runtimeFor }) => {
  const build = await currentIndex().prepareBuild(app, 'c'.repeat(40), builds);
  const checked = parseManagedApplicationPlan({ ...planA, commit: build.commit, artifact: build.artifact, grants: { ...planA.grants, maintenance: true },
    services: { leader: { ...planA.services.leader, inputs: { ...planA.services.leader.inputs, environment: { RELEASE: { kind: 'literal', value: 'C' } } } } },
    rollout: { ...planA.rollout, strategy: 'maintenance', rollback_compatible: false, checks: [{ id: 'active', service: 'leader', command: ['node', '--eval', 'setInterval(()=>{},1000)'], timeout_seconds: 2 }] },
  }); assert.ok(checked.ok, checked.ok ? '' : checked.error);
  const source = await currentIndex().proposeManagedDeployment(app, checked.value, randomUUID(), proposalPorts); assert.equal(source.action, incarnation + ':6'); await lifecycle.begin(source);
  const held = await wait(async () => { const value = await lifecycle.tick(); return value.operation.phase === 'held' ? value : false; }, source.createdAt + 300000, 'unsafe maintenance candidate');
  assert.equal(held.operation.recoverySource, null); assert.equal(held.compatibilityEpoch, 1); assert.ok(held.operation.compatibilityFencedAt); assert.equal(held.operation.verification.reason, 'deadline'); assert.ok(held.operation.verification.steps[0].execution.runningAt); assert.equal(held.operation.verification.steps[0].execution.evidence, null);
  const original = await native.observe({ app, incarnation, dataOwner, service: 'leader' }); assert.equal(original.status, 'owned');
  const volumes = ownedVolumes(api); const originalVolume = await volumes.observe(allocation.value); assert.equal(originalVolume.status, 'owned');
  const request = { app, blockedRun: held.operation.run, request: randomUUID(), commit: 'e'.repeat(40), reason: 'Build a reviewed forward fix for the held maintenance singleton' };
  const actor = { kind: 'operator-control', identity: 'lab-forward-selector' }; const preparation = { ...proposalPorts, authorize: async (decision) => decision.owner.incarnation === incarnation && decision.owner.dataOwner === dataOwner };
  const selection = await currentIndex().selectManagedForward(app, request, actor, preparation);
  const prepared = await currentIndex().prepareManagedForwardBuild(app, request, { ...builds, authorizeSelection: preparation.authorize });
  const target = parseManagedApplicationPlan({ ...checked.value, commit: prepared.build.commit, artifact: prepared.build.artifact, services: { leader: { ...checked.value.services.leader, inputs: { ...checked.value.services.leader.inputs, environment: { RELEASE: { kind: 'literal', value: 'D' } } } } }, rollout: { ...checked.value.rollout, checks: planA.rollout.checks } }); assert.ok(target.ok);
  const operator = { actor: { kind: 'operator-control', identity: 'lab-forward-recovery' }, reason: 'Fence the held maintenance candidate under a separately audited continuation' };
  const ports = { ...preparation, images: builds.images, authorizeReservation: async (decision, _candidate, actual) => decision.id === selection.id && JSON.stringify(actual) === JSON.stringify(operator) };
  const reservation = await currentIndex().reserveManagedForward(app, request, target.value, operator, ports); assert.equal(reservation.action, incarnation + ':7'); assert.deepEqual(reservation.operator, operator); assert.notDeepEqual(reservation.operator.actor, selection.audit.actor);
  const accounting = await currentIndex().resourceSnapshot(); assert.equal(accounting.charges[0].sequence, 6); assert.equal(accounting.charges[0].result, 'pending');
  const initialized = await currentIndex().prepareManagedForwardCleanup(app, request, ports); assert.equal(initialized.reservation.phase, 'fencing'); assert.equal(initialized.state.phase, 'fencing'); assert.ok(initialized.state.nodes[0].checks.length > 0);
  const writes = []; const jobs = oneShotJob(api); const containers = checkContainerFences(api);
  const runtime = (context) => managedForwardCleanupRuntime(context, { now: Date.now, authority: { allowed: async (base, permission) => base.owner.incarnation === incarnation && base.owner.dataOwner === dataOwner && base.application.host.node === swarm.NodeID && (permission.kind === 'recovery' || permission.kind === 'job' && permission.effect === 'observe') },
    native: { services: { observe: native.observe, tombstone: async (...args) => { const at = Date.now(); const result = await native.tombstone(...args); writes.push({ at, action: args[0], expected: args[1], result }); return result; } }, jobs: { observe: jobs.observe }, containers },
  });
  await wait(async () => { await currentIndex().tickManagedForwardCleanup(app, request, ports, runtime); return writes.length > 0; }, reservation.deadline, 'first reserved consumer stop'); await reopen();
  const complete = await wait(async () => { const value = await currentIndex().tickManagedForwardCleanup(app, request, ports, runtime); assert.notEqual(value.phase, 'held'); return value.phase === 'complete' ? value : false; }, reservation.deadline, 'reserved cleanup and pinned container cessation');
  assert.equal(complete.createdAt, reservation.createdAt); assert.equal(complete.deadline, reservation.deadline); assert.ok(complete.nodes.every((node) => node.barrier.phase === 'complete' && node.proofs.length === node.checks.length)); assert.ok(writes.every((item) => item.action.action.startsWith(reservation.action + ':quiesce:')));
  assert.equal(new Set(writes.map((item) => item.action.action + item.action.service)).size, writes.length);
  const stopped = await native.observe({ app, incarnation, dataOwner, service: 'leader' }); assert.equal(stopped.status, 'owned'); assert.equal(stopped.id, original.id); assert.equal(stopped.replicas, 0); assert.equal(stopped.containersStopped, true); assert.equal(stopped.retainedInputsCleared, true);
  assert.deepEqual(await lifecycle.read(), held); assert.deepEqual(await currentIndex().resourceSnapshot(), accounting); assert.deepEqual(await currentIndex().recordedManagedVolumes(app, [allocation.value]), [receipt]);
  const afterVolume = await volumes.observe(allocation.value); assert.deepEqual(afterVolume, originalVolume);
  const history = execFileSync('docker', ['run', '--rm', '--read-only', '--network', 'none', '--memory', '128m', '--cpus', '0.25', '--mount', 'type=volume,source=' + allocation.value.name + ',target=/data,readonly', '--entrypoint', 'node', image, '--eval', "process.stdout.write(require('node:fs').readFileSync('/data/history','utf8'))"], { encoding: 'utf8', timeout: 30000 });
  const records = history.trim().split('\n').map((line) => JSON.parse(line)); assert.ok(records.some((event) => event.release === 'C' && event.event === 'effect')); assert.ok(records.some((event) => event.release === 'C' && event.event === 'released')); assert.deepEqual(records.filter((event) => event.event === 'acquired').map((event) => event.release), ['A', 'B', 'A', 'C']); assert.ok(!records.some((event) => event.release === 'D'));
  const shared = JSON.parse(await readFile(join(path, 'app-index', createHash('sha256').update(app).digest('hex'), 'state.json'), 'utf8')); assert.equal(shared.forward.action, reservation.action); assert.equal(shared.fence.lifecycle.active.sequence, 6); assert.equal(shared.fence.nextAction, 8); assert.equal(shared.managed.at(-1).completion, null);
  const unavailableRetained = async () => { throw new Error('singleton has no separate retained dependency'); };
  const handoff = await currentIndex().prepareManagedForwardHandoff(app, request, ports, runtime, unavailableRetained);
  const lease = await currentIndex().transferManagedForwardAdmission(app, request, {
    ...ports, observeHost: (host) => observeSwarmHost(host, api),
    authorizeTransfer: async (source) => source.forward.decision === selection.id && source.run === request.request && source.candidate.grants.maintenance,
  }, runtime, unavailableRetained);
  assert.equal(lease.source, handoff.reservation.handoff.source);
  const transferred = await currentIndex().resourceSnapshot();
  assert.equal(transferred.charges[0].sequence, 7);
  assert.equal(transferred.charges[0].result, 'pending');
  await reopen();
  const installed = await currentIndex().installManagedForwardRoot(app, request, ports, runtime, unavailableRetained);
  assert.equal(installed.operation.phase, 'allocating');
  assert.equal(installed.active, null);
  assert.deepEqual(installed.lastGood, held.lastGood);
  const beforeSwitch = await native.observe({ app, incarnation, dataOwner, service: 'leader' });
  assert.equal(beforeSwitch.status, 'owned'); assert.equal(beforeSwitch.replicas, 0);
  const activationAt = Date.now();
  const accepted = await currentIndex().activateManagedForward(app, request, ports, runtime, unavailableRetained);
  assert.equal(accepted.run, request.request);
  const successor = await currentIndex().managedExecutionContext(app, accepted.run, { ...ports });
  assert.ok(successor); assert.equal(successor.action, reservation.action);
  const composed = runtimeFor(successor);
  const verified = await wait(async () => {
    const state = await currentIndex().tickManagedDeployment(app, accepted.run, composed);
    assert.notEqual(state.operation.phase, 'held', JSON.stringify(state.operation));
    return state.operation.phase === 'complete' ? state : false;
  }, accepted.deadline, 'verify successor singleton');
  assert.equal(verified.active.run, accepted.run); assert.equal(verified.compatibilityEpoch, held.compatibilityEpoch + 1);
  assert.equal((await currentIndex().resourceSnapshot()).charges[0].result, 'target');
  assert.deepEqual(await currentIndex().recordedManagedVolumes(app, [allocation.value]), [receipt]);
  const after = await native.observe({ app, incarnation, dataOwner, service: 'leader' });
  assert.equal(after.status, 'owned'); assert.equal(after.id, original.id); assert.equal(after.replicas, 1);
  const task = after.tasks.find((item) => item.state === 'running' && item.desired === 'running'); assert.ok(task);
  const container = (await api.request('GET', '/tasks/' + task.id)).value.Status.ContainerStatus.ContainerID;
  const forwardedHistory = execFileSync('docker', ['exec', container, 'node', '--eval', "process.stdout.write(require('node:fs').readFileSync('/data/history','utf8'))"], { encoding: 'utf8', timeout: 10000 });
  assert.deepEqual(forwardedHistory.trim().split('\n').map((line) => JSON.parse(line)).filter((event) => event.event === 'acquired').map((event) => event.release), ['A','B','A','C','D']);
  const finalEnvelope = JSON.parse(await readFile(join(path, 'app-index', createHash('sha256').update(app).digest('hex'), 'state.json'), 'utf8'));
  assert.equal(finalEnvelope.managed.find((item) => item.run === held.operation.run).completion.outcome, 'superseded');
  assert.equal(finalEnvelope.managed.find((item) => item.run === held.operation.run).completion.successor, accepted.run);
  await writeFile(join(path, 'forward-successor-history.json'), forwardedHistory);
  const registrationRoot = join(path, 'retirement-registration');
  await mkdir(registrationRoot, { mode: 0o755 });
  const storage = (mode, payload) => execFileSync('python3', ['-B', '-c', `
import json, os, sys
import registration_generation as storage
root = os.open(sys.argv[1], storage._DIR_FLAGS)
try:
    value = json.load(sys.stdin)
    if sys.argv[2] == "publish":
        storage.publish(root, value["owner"]["registration"], value["registration"], {}, {}, 1000, ownership=value["owner"])
    else:
        storage.withdraw_managed(root, value, 1000)
finally:
    os.close(root)
`, registrationRoot, mode], {
    input: JSON.stringify(payload), env: { ...process.env, PYTHONPATH: fileURLToPath(new URL('../../../scripts/server-lib/', import.meta.url)) }, timeout: 10000,
  });
  const registration = target.value.infrastructure.registration;
  storage('publish', {
    owner: { version: 1, runtime: 'swarm', registration, ownership: target.value.infrastructure.ownership },
    registration: { name: app, repo: 'https://example.invalid/lab/singleton.git', ref: 'main', path: '.', runtime: 'swarm',
      hosts: [], secrets: [], grants: target.value.grants },
  });
  const removalWrites = [];
  let lostRemove = false;
  const removalApi = { request: async (...args) => {
    const result = await api.request(...args);
    const action = args[2]?.Labels?.['com.kayra.action'];
    if (args[0] === 'POST' && args[1].startsWith('/services/') && typeof action === 'string') {
      removalWrites.push({ action, at: Date.now(), status: result.status });
      if (!lostRemove && action.endsWith(':remove:1') && result.status === 200) { lostRemove = true; throw new Error('lost native removal acknowledgement'); }
    }
    return result;
  } };
  const removal = () => managedPlatform(currentIndex(), {
    publicRegistrations: join(registrationRoot, 'public'), privateRegistrations: join(registrationRoot, 'private'),
    swarmAuthority: join(registrationRoot, 'unused-host.json'), migrationPolicy: join(registrationRoot, 'unused-policy.json'), domain: 'lab.test',
  }, { api: removalApi, builds, canAccess: async (name) => name === app, actor }).removal;
  const step = () => removal().step(app);
  const removalDeadline = Date.now() + 90000;
  const beforeStop = await wait(async () => {
    const status = await step();
    assert.equal(status.status, 'removing');
    return lostRemove ? status : false;
  }, removalDeadline, 'first native removal with lost acknowledgement');
  assert.equal((await currentIndex().resourceSnapshot()).charges[0].result, 'target');
  await reopen();
  const withdrawal = await wait(async () => {
    const status = await step();
    if (status.status === 'withdraw-registration') return status.withdrawal;
    assert.equal(status.status, 'removing', JSON.stringify(status));
    assert.equal(status.request, beforeStop.request); assert.equal(status.deadline, beforeStop.deadline);
    return false;
  }, beforeStop.deadline, 'native removal scrub and accounting retirement');
  assert.equal(withdrawal.request, beforeStop.request);
  assert.equal((await currentIndex().resourceSnapshot()).charges[0].result, 'absent');
  assert.deepEqual(removalWrites.map((item) => item.action), [withdrawal.action + ':remove:1', withdrawal.action + ':scrub:1']);
  const finalNative = await native.observe({ app, incarnation, dataOwner, service: 'leader' });
  assert.equal(finalNative.status, 'owned'); assert.equal(finalNative.id, original.id);
  assert.equal(finalNative.replicas, 0); assert.equal(finalNative.containersStopped, true); assert.equal(finalNative.retainedInputsCleared, true);
  await assert.rejects(removal().finalize(app, withdrawal.request), /withdrawal is unverified/);
  storage('withdraw', withdrawal);
  await reopen();
  const removed = await removal().finalize(app, withdrawal.request);
  assert.deepEqual(removed, { status: 'removed', request: withdrawal.request }); assert.deepEqual(await step(), removed);
  const tombstone = await currentIndex().managedRemovalTombstone(app);
  assert.deepEqual(tombstone.volumes, [allocation.value]);
  assert.equal(await currentIndex().managedDeploymentStatus(app, ports), null);
  assert.deepEqual(await volumes.observe(allocation.value), originalVolume);
  const retainedHistory = execFileSync('docker', ['run', '--rm', '--read-only', '--network', 'none', '--memory', '128m', '--cpus', '0.25', '--mount',
    'type=volume,source=' + allocation.value.name + ',target=/data,readonly', '--entrypoint', 'node', image, '--eval',
    "process.stdout.write(require('node:fs').readFileSync('/data/history','utf8'))"], { encoding: 'utf8', timeout: 30000 });
  assert.ok(retainedHistory.startsWith(forwardedHistory));
  assert.ok(retainedHistory.trim().split('\n').map((line) => JSON.parse(line)).some((item) => item.release === 'D' && item.event === 'released'));
  await writeFile(join(path, 'removal-state.json'), JSON.stringify({ tombstone, writes: removalWrites, lostRemove, finalNative }, null, 2));
  await writeFile(join(path, 'removal-retained-history.json'), retainedHistory);

  const result = { passed: true, scope: 'native indexed forward handoff and verified singleton activation with fixture builds/compiler/grants and a preserved coordination volume', blockedRun: held.operation.run, unknownCheckExec: held.operation.verification.steps[0].execution.id, request: request.request, sourceAction: source.action, reservedAction: reservation.action, deadline: reservation.deadline, originalDeadlinePreserved: true, separateOperatorAudit: true, consumerStopReopened: true, pinnedCheckPhysicallyStopped: true, unsafeDataEpoch: held.compatibilityEpoch, heldRootUnchanged: true, admissionUnsettledAndUnchanged: true, successorVerified: true, successorCompatibilityEpoch: verified.compatibilityEpoch, successorAdmissionSettled: true, removal: { removed, nativeWrites: removalWrites.length, lostAcknowledgement: lostRemove, retainedVolume: true, originalDeadline: beforeStop.deadline, actualPlatformWithdrawal: true }, activationAt, successorRun: accepted.run, service: stopped.id, nativeWrites: writes.length, stoppedCheckContainers: complete.nodes.flatMap((node) => node.proofs).length, coordinationVolumeUnchanged: true, retainedDataEvents: records.length, receipt };
  await writeFile(join(path, 'forward-history.json'), history); await writeFile(join(path, 'forward-writes.json'), JSON.stringify(writes, null, 2)); await writeFile(join(path, 'forward-cleanup-state.json'), JSON.stringify(complete, null, 2)); await writeFile(join(path, 'forward-cleanup-result.json'), JSON.stringify(result, null, 2)); return result;
};
