// Journal/admission component only: fixture build/image inputs; application runtime effects are forbidden.
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRolloutPlan } from '../../../cli/src/contracts/rollout-plan.ts';
import { createLifecycleAppIndex, openLifecycleAppIndex } from '../../../cli/src/server/deployment/lifecycle-app-index.ts';
import { openArtifactStore } from '../../../cli/src/server/deployment/artifact-store.ts';
import { openJournal } from '../../../cli/src/server/deployment/journal.ts';
import { rolloutExecution } from '../../../cli/src/server/deployment/rollout-execution.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { observeSwarmHost } from '../../../cli/src/server/runtime/swarm-host.ts';

const [mode, directory, checkpoint] = process.argv.slice(2); assert.ok(directory);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); const api = dockerApi(); const reads = []; let runtimeCalls = 0;
const forbidden = () => { runtimeCalls++; throw new Error('expired handoff application runtime must not be touched'); };
const portsFor = async () => ({ ...await openArtifactStore(join(directory, 'artifacts')), now: Date.now,
  observeHost: (host) => observeSwarmHost(host, { request: async (...args) => { assert.equal(args[0], 'GET'); reads.push({ method: args[0], path: args[1] }); return api.request(...args); } }),
  native: { observe: forbidden, observeDesired: forbidden, apply: forbidden, fence: forbidden, tombstone: forbidden },
  jobs: { observe: forbidden, create: forbidden, start: forbidden, fence: forbidden }, materialize: forbidden, routing: forbidden, readiness: { check: forbidden },
});
if (mode === 'writer') {
  setInterval(() => {}, 1000);
  const context = JSON.parse(await readFile(join(directory, 'context.json'), 'utf8')); const target = context[checkpoint]; const indexPath = join(directory, 'index');
  const stop = async () => {
    await new Promise((resolve, reject) => process.send({ checkpoint, request: target.preparation.run }, (error) => error ? reject(error) : resolve()));
    await new Promise(() => {});
  };
  const journals = async (path, journalMode) => {
    const journal = await openJournal(path, journalMode);
    return { ...journal, write: async (value) => {
      const completion = value?.rollout?.preparation?.run === target.preparation.run && value.rollout.completion?.kind === 'expired-handoff';
      if (checkpoint === 'before-completion' && completion) await stop();
      await journal.write(value);
      if (checkpoint === 'after-completion' && completion) await stop();
    } };
  };
  const index = await openLifecycleAppIndex(indexPath, undefined, journals); const ports = await portsFor();
  await rolloutExecution(index, ports).tick(target.preparation.app, target.preparation.run);
  throw new Error('writer did not reach its requested checkpoint');
}
assert.equal(mode, 'run'); await mkdir(directory, { mode: 0o700 }); let index; const reports = [];
try {
  const host = JSON.parse(await readFile('/var/lib/kayra/swarm/authority.json', 'utf8'));
  const template = JSON.parse(await readFile(new URL('../../../ci/tests/swarm-http/native-plan.json', import.meta.url), 'utf8'));
  const ports = await portsFor(); const prefix = 'handoff-expiry-lab-' + randomUUID().slice(0, 8);
  index = await createLifecycleAppIndex(join(directory, 'index'), (identity) => Promise.resolve({ ...identity, status: 'applied' }));
  const context = {};
  for (const name of ['before-completion', 'after-completion']) {
    const app = prefix + '-' + String(Object.keys(context).length); await index.prepareApp(app); const generation = randomUUID();
    const ticket = await index.reserveRegistration(app, generation, 'swarm'); await index.submitRegistration(app, ticket, generation); await index.reconcileRegistration(app, ticket, generation);
    const commit = 'a'.repeat(40); await index.prepareBuild(app, commit, { ...ports, images: () => [], prepare: async () => JSON.stringify({ fixture: true, commit }) });
    const planPorts = { ...ports, preview: async (registration, _runtime, sha, artifact) => {
      // This deliberately unexecuted image reference tests admission, not registry or workload readiness.
      const workload = { ...template, app, registration, host, commit: sha, artifact,
        services: { web: { ...template.services.web, image: `localhost:5000/${app}/web@sha256:${'d'.repeat(64)}` } },
        routes: template.routes.map((route) => ({ ...route, host: `${app}.lab.test` })) };
      const plan = parseRolloutPlan({ version: 2, runtime: 'swarm', workload, rollout: workload.rollout,
        policy: { version: 1, migrationTimeoutCeilingSeconds: 90, schedulingSeconds: 90, cleanupSeconds: 30, maximumAttempts: 8 } });
      assert.ok(plan.ok, plan.error); return plan.value;
    } };
    const prepared = await index.prepareRollout(app, randomUUID(), commit, planPorts);
    await index.admitRollout(app, prepared.ticket, ports);
    await rolloutExecution(index, ports).tick(app, prepared.preparation.run);
    const ready = await index.rolloutOperation(app, prepared.preparation.run);
    assert.equal(ready.preparation.phase, 'ready'); assert.ok(ready.preparation.httpDeadline);
    context[name] = ready;
  }
  await writeFile(join(directory, 'context.json'), JSON.stringify(context));
  const killAt = async (name) => {
    await index.close(); index = undefined;
    const child = fork(fileURLToPath(import.meta.url), ['writer', directory, name], { execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }); const exited = once(child, 'exit');
    try { const [message] = await Promise.race([once(child, 'message', { signal: AbortSignal.timeout(30_000) }), exited.then(() => { throw new Error('writer exited before checkpoint'); })]);
      assert.equal(message.checkpoint, name); child.kill('SIGKILL'); const [, signal] = await exited; assert.equal(signal, 'SIGKILL');
    } finally { child.kill('SIGKILL'); await exited; }
    index = await openLifecycleAppIndex(join(directory, 'index'));
  };
  const deadline = Math.max(...Object.values(context).map((item) => item.preparation.httpDeadline)) + 1000;
  console.log(JSON.stringify({ checkpoint: 'waiting-for-original-http-expiry', deadline }));
  while (Date.now() < deadline) await pause(Math.min(1000, deadline - Date.now()));
  for (const name of Object.keys(context)) {
    await killAt(name); const original = context[name]; const app = original.preparation.app; const run = original.preparation.run;
    const interrupted = await index.rolloutOperation(app, run);
    assert.equal(interrupted.preparation.httpDeadline, original.preparation.httpDeadline);
    assert.equal(interrupted.preparation.deadline, original.preparation.deadline);
    assert.equal(interrupted.completion?.kind, name === 'before-completion' ? undefined : 'expired-handoff');
    assert.equal((await index.resourceSnapshot()).charges.find((charge) => charge.app === app).result, 'pending');
    assert.equal(await rolloutExecution(index, ports).tick(app, run), 'failed');
    const recovered = await index.rolloutOperation(app, run); assert.equal(recovered.completion.kind, 'expired-handoff');
    assert.equal(recovered.completion.reason, 'deadline'); assert.equal(await index.httpOperation(app, run), undefined);
    assert.equal(recovered.preparation.httpDeadline, original.preparation.httpDeadline);
    assert.equal((await index.resourceSnapshot()).charges.find((charge) => charge.app === app).result, 'absent');
    const status = await index.deploymentStatus(app); assert.equal(status.verifiedActive, null);
    assert.equal(status.preparation.recovery, 'no-active-release'); assert.deepEqual(status.preparation.migrationOutcomes, []);
    reports.push({ name: 'kill-' + name, passed: true, originalHttpDeadline: original.preparation.httpDeadline, completion: recovered.completion, status });
  }
  assert.deepEqual(await index.pendingRolloutOperations(), []); assert.equal(runtimeCalls, 0);
  const states = await Promise.all(Object.values(context).map(async (item) => ({ operation: await index.rolloutOperation(item.preparation.app, item.preparation.run), status: await index.deploymentStatus(item.preparation.app) })));
  await writeFile(join(directory, 'states.json'), JSON.stringify(states)); await writeFile(join(directory, 'host-reads.json'), JSON.stringify(reads));
  const version = await api.request('GET', '/version'); await index.close(); index = undefined;
  const result = { passed: true, reports, engine: version.value.Version, api: version.value.ApiVersion, node: process.version, applicationRuntimeCalls: runtimeCalls,
    scope: 'real SIGKILL at synchronized journal boundaries and real host observations; fixture build/image inputs; application workload effects forbidden' };
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  if (index) await index.close(); const failure = { error: String(error), directory, reports, cleanup: `inspect evidence, then remove only ${directory}` };
  await writeFile(join(directory, 'failure.json'), JSON.stringify(failure, null, 2)); console.error(JSON.stringify(failure)); process.exitCode = 1;
}
