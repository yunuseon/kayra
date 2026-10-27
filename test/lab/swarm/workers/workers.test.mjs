import test from 'node:test';
import assert from 'node:assert/strict';
import { assessWorker, workerVerdict, workerScenarios } from './results.mjs';
const at = (ms) => new Date(1700000000000 + ms).toISOString();
function queue(scenario = 'effect-idempotent') {
  return { scenario, repeat: 1, before: { Spec: { Mode: { Replicated: { Replicas: 1 } }, UpdateConfig: { Order: 'start-first' }, TaskTemplate: { ContainerSpec: { StopGracePeriod: 30000000000 } } } }, after: {}, initial: { task: 'aaaa' }, killed: 'aaaabbbb', timeline: [{ kind: 'kill-acknowledged', at: 1 }, { kind: 'work-completed', at: 10001 }], database: {
    jobs: Array.from({ length: 20 }, (_, id) => ({ id, state: 'done', attempts: id === 0 ? 2 : 1 })),
    effects: Array.from({ length: 20 }, (_, job_id) => ({ job_id })), raw_effects: [], ownership: [], ticks: [],
    history: [{ kind: 'claimed', job_id: 0 }, { kind: 'claimed', job_id: 0 }, { kind: 'effect-committed', job_id: 0 }, { kind: 'effect-committed', job_id: 0 }, { kind: 'before-ack-paused', job_id: 0 }],
  } };
}
function singleton(locked) {
  const evidence = queue(locked ? 'singleton-locked' : 'singleton-unlocked');
  delete evidence.killed;
  evidence.after = { UpdateStatus: { State: 'completed' } };
  evidence.database = { jobs: [], effects: [], raw_effects: [], ownership: [{ task: 'A', release: 'A', started_at: at(0), ended_at: at(10000) }, { task: 'B', release: 'B', started_at: at(locked ? 10001 : 5000), ended_at: at(20000) }], ticks: [{ release: 'A', at: at(6000) }, { release: 'B', at: at(7000) }], history: [{ kind: 'started', release: 'B', at: at(4000) }, { kind: 'acquired', release: 'A' }, { kind: 'acquired', release: 'B' }, { kind: 'standby', release: 'B' }] };
  return evidence;
}
test('redelivery can have two attempts and one durable effect per job', () => assert.equal(assessWorker(queue()).passed, true));
test('acknowledged jobs without effects fail replay', () => { const evidence = queue(); evidence.database.effects.pop(); assert.equal(assessWorker(evidence).passed, false); });
test('negative control must actually duplicate the durable effect', () => {
  const evidence = queue('effect-without-idempotency');
  evidence.database.raw_effects = evidence.database.effects; evidence.database.effects = [];
  assert.equal(assessWorker(evidence).passed, false);
  evidence.database.raw_effects.push({ job_id: 0 });
  assert.equal(assessWorker(evidence).passed, true);
});
test('singleton lock must exclude work despite process overlap', () => {
  assert.equal(assessWorker(singleton(true)).passed, true);
  const evidence = singleton(true); evidence.database.ownership[1].started_at = at(5000);
  assert.equal(assessWorker(evidence).passed, false);
});
test('unlocked negative control requires work from both owners in overlap', () => {
  const evidence = singleton(false); assert.equal(assessWorker(evidence).passed, true);
  evidence.database.ticks.pop(); assert.equal(assessWorker(evidence).passed, false);
});
test('smoke matrix cannot count as three-repeat evidence', () => {
  const results = workerScenarios.map((scenario) => ({ scenario, repeat: 1, passed: true }));
  assert.equal(workerVerdict(results).complete, false);
  assert.equal(workerVerdict([1,2,3].flatMap((repeat) => results.map((row) => ({ ...row, repeat })))).complete, true);
});
