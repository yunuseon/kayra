import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseApplicationPlan } from '../../../cli/src/contracts/application-plan.ts';
import { parseRolloutPlan } from '../../../cli/src/contracts/rollout-plan.ts';
import { createLifecycleAppIndex, openLifecycleAppIndex } from '../../../cli/src/server/deployment/lifecycle-app-index.ts';
import { oneShotCleanup } from '../../../cli/src/server/runtime/one-shot-job.ts';
import { openJournal } from '../../../cli/src/server/deployment/journal.ts';
import { deploymentControl } from '../../../cli/src/server/deployment/deployment-control.ts';
import { observeSwarmHost } from '../../../cli/src/server/runtime/swarm-host.ts';

/** Fixture registration/build ports isolate the indexed owner; this is not the public deployer pipeline. */
export const indexedMigrationOwner = async (path, source, ports, checkpoint, initialize, hostFault) => {
  const indexPath = join(path, 'index'); const app = source.scope.app; const request = source.scope.run; const commit = 'a'.repeat(40);
  const journals = async (location, mode) => {
    const journal = await openJournal(location, mode);
    return { ...journal, write: async (value) => {
      const audit = value?.rollout?.preparation?.sequence?.steps.some((step) => step.resolution !== undefined);
      if (audit && checkpoint === 'before-audit') process.kill(process.pid, 'SIGKILL');
      await journal.write(value);
      if (audit && checkpoint === 'after-audit') process.kill(process.pid, 'SIGKILL');
    } };
  };
  const index = initialize ? await createLifecycleAppIndex(indexPath, (identity) => Promise.resolve({ ...identity, status: 'applied' })) : await openLifecycleAppIndex(indexPath, undefined, journals);
  try {
    if (initialize) {
      await index.prepareApp(app); const generation = randomUUID(); const ticket = await index.reserveRegistration(app, generation, 'swarm');
      await index.submitRegistration(app, ticket, generation); await index.reconcileRegistration(app, ticket, generation);
      const retained = await index.prepareBuild(app, commit, { ...ports, images: () => [], prepare: async () => JSON.stringify({ fixture: true, commit }) });
      const checked = parseApplicationPlan(JSON.parse(await readFile(new URL('../../../ci/tests/swarm-http/native-plan.json', import.meta.url), 'utf8'))); assert.ok(checked.ok);
      const template = source.steps[0].template; assert.ok(source.steps.every((step) => JSON.stringify(step.template) === JSON.stringify(template)));
      const host = JSON.parse(await readFile('/var/lib/kayra/swarm/authority.json', 'utf8'));
      const workload = { ...checked.value, app, registration: retained.registration, commit, artifact: retained.artifact, host,
        services: { web: { ...checked.value.services.web, image: template.image, environment: template.environment, entrypoint: template.entrypoint,
          resources: { ...checked.value.services.web.resources, memoryBytes: template.resources.memoryBytes, nanoCpus: template.resources.nanoCpus }, stopGraceSeconds: template.stopGraceSeconds } },
        routes: checked.value.routes.map((route) => ({ ...route, host: `${app}.lab.test` })) };
      const plan = parseRolloutPlan({ version: 2, runtime: 'swarm', workload, rollout: { ...workload.rollout, migrations: source.steps.map((step) => step.definition) },
        policy: { version: 1, schedulingSeconds: 90, cleanupSeconds: 30, maximumAttempts: 8, migrationTimeoutCeilingSeconds: source.policy.timeoutCeilingSeconds } });
      assert.ok(plan.ok, plan.error);
      const operation = await index.prepareRollout(app, request, commit, { ...ports, preview: async () => plan.value });
      await index.admitRollout(app, operation.ticket, { ...ports, observeHost: observeSwarmHost });
    }
    const operation = await index.rolloutOperation(app, request); assert.ok(operation?.admitted);
    let hostAvailable = hostFault !== 'before-create'; let materializations = 0;
    const observeHost = (authority) => hostAvailable ? observeSwarmHost(authority) : Promise.resolve({ status: 'unavailable' });
    const tick = async () => {
      const preparation = await index.tickRolloutPreparation(app, request, { ...ports, observeHost,
        materialize: async (...args) => { materializations++; return ports.materialize(...args); }, native: { ...ports.native,
          fence: (...args) => hostFault === 'cleanup-fence' && args[0].scope.purpose === 'migration' ? Promise.resolve('uncertain') : ports.native.fence(...args),
          create: async (...args) => { const result = await ports.native.create(...args); if (hostFault === 'after-create') { assert.equal(result, 'acknowledged'); hostAvailable = false; } return result; },
          start: async (...args) => {
            if (checkpoint === 'before-start' && args[0].scope.purpose === 'migration') process.kill(process.pid, 'SIGKILL');
            const result = await ports.native.start(...args); if (hostFault === 'after-start') { assert.equal(result, 'acknowledged'); hostAvailable = false; } return result;
          } } });
      if (checkpoint === 'after-advance' && preparation.sequence?.position === 1) process.kill(process.pid, 'SIGKILL');
      if (preparation.phase === 'ready' || preparation.phase === 'held') {
        const resources = await index.resourceSnapshot(); const status = await index.deploymentStatus(app);
        assert.equal(resources.charges[0].target.plan, preparation.plan); assert.equal(resources.charges[0].result, 'pending');
        assert.equal(status.verifiedActive, null);
        if (hostFault === 'before-create') assert.equal(materializations, 0);
        if (hostFault === 'after-start' && preparation.phase === 'ready') {
          await assert.rejects(index.handoffRollout(app, request, { ...ports, observeHost }), /current resource host/);
          assert.equal(await index.httpOperation(app, request), undefined);
        }
        await writeFile(join(path, 'indexed.json'), JSON.stringify({ operation: await index.rolloutOperation(app, request), resources, status,
          hostFault: hostFault ?? null, materializations,
          scope: 'indexed lifecycle and native migration effects; fixture registration/build ports; HTTP handoff only' }));
      }
      return { ...preparation.sequence, phase: preparation.phase === 'ready' ? 'succeeded' : preparation.phase === 'held' ? 'held' : 'running',
        reason: preparation.sequence?.reason ?? preparation.reason, deadline: preparation.deadline, steps: preparation.sequence?.steps ?? [], preparation };
    };
    const control = deploymentControl({ index, now: ports.now, enabled: async () => false, canAccess: async (name) => name === app,
      recovery: { actor: { kind: 'operator-control', identity: 'native-lab-control' }, ports } });
    const cleanupRequest = async () => {
      const filename = join(path, 'cleanup-request.json');
      const saved = await readFile(filename, 'utf8').then(JSON.parse, () => undefined);
      const request = saved ?? { app, run: operation.preparation.run, step: 'schema', purpose: 'migration', attempt: 1, action: randomUUID(), reason: 'Fence held native migration before inspecting application ledger' };
      if (!saved) await writeFile(filename, JSON.stringify(request));
      return request;
    };
    const tickCleanup = async () => {
      const request = await cleanupRequest(); const native = oneShotCleanup();
      return index.tickMigrationCleanup(app, request, { ...ports, native: { ...native, fence: async (...args) => {
        const result = await native.fence(...args);
        if (checkpoint === 'after-cleanup') { assert.equal(result, 'acknowledged'); process.kill(process.pid, 'SIGKILL'); }
        return result;
      } } });
    };
    return { journal: { close: index.close }, owner: { prepare: async () => operation.preparation, tick,
      requestCleanup: async () => control('/deployment/migration-cleanup', await cleanupRequest()), tickCleanup,
      cleanupAudit: () => control('/deployment/migration-cleanup-audit', { app, run: request, step: 'schema' }),
      resolve: (outcome) => control('/deployment/migration-resolve', { app, run: request, step: 'schema', outcome, reason: 'Verified application-owned migration ledger' }),
      audit: () => control('/deployment/migration-audit', { app, run: request, step: 'schema' }),
      status: () => index.deploymentStatus(app), resources: () => index.resourceSnapshot(),
    } };

  } catch (error) { await index.close(); throw error; }
};
