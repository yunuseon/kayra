import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { jobName, jobPlanDigest } from '../../../cli/src/contracts/one-shot-job.ts';
import { oneShotExecution } from '../../../cli/src/server/deployment/one-shot-execution.ts';
import { openJournal } from '../../../cli/src/server/deployment/journal.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { oneShotJob } from '../../../cli/src/server/runtime/one-shot-job.ts';

const [directory, sourceImage] = process.argv.slice(2); assert.ok(directory);
assert.match(sourceImage, /^localhost:5000\/[a-z][a-z0-9-]{0,47}\/web@sha256:[0-9a-f]{64}$/);
await mkdir(directory, { mode: 0o700 }); const run = promisify(execFile); const api = dockerApi(); const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const app = 'cold-job-' + randomUUID().slice(0, 8); const tag = `localhost:5000/${app}/web:fixture`;
await run('docker', ['image', 'tag', sourceImage, tag]); await run('docker', ['image', 'push', tag], { maxBuffer: 1024 * 1024 });
const information = JSON.parse((await run('docker', ['image', 'inspect', tag])).stdout)[0];
const image = information.RepoDigests.find((value) => value.startsWith(`localhost:5000/${app}/web@sha256:`)); assert.ok(image);
await run('docker', ['image', 'rm', tag]);
const imagePath = `/images/${encodeURIComponent(image)}`;
if ((await api.request('GET', imagePath + '/json')).status === 200) assert.equal((await api.request('DELETE', imagePath)).status, 200);
assert.equal((await api.request('GET', imagePath + '/json')).status, 404);
let pulls = 0; const native = oneShotJob({ request: async (...args) => { if (args[1].startsWith('/images/create?')) pulls++; return api.request(...args); } });
const plan = { version: 1, scope: { app, incarnation: randomUUID(), run: randomUUID(), step: 'cold', purpose: 'migration', attempt: 1 }, image,
  command: ['sh', '-c', "printf 'cold image executed\\n'"], entrypoint: null, environment: {},
  resources: { memoryBytes: 64 * 1024 * 1024, nanoCpus: 100_000_000 }, networks: [], deadline: Date.now() + 60000, stopGraceSeconds: 30,
};
await writeFile(join(directory, 'plan.json'), JSON.stringify(plan));
const journal = await openJournal(directory); const owner = oneShotExecution(journal, { native, now: Date.now,
  read: async (digest) => { assert.equal(digest, jobPlanDigest(plan)); return plan; }, authorize: async () => true, materialize: async () => ({}) });
await owner.prepare(plan); const trace = []; let final;
while (Date.now() < plan.deadline + 30000) {
  const value = await owner.tick(); trace.push({ at: Date.now(), value }); assert.notEqual(value.phase, 'held');
  if (value.phase === 'complete') { final = value; break; } await pause(100);
}
assert.ok(final); assert.equal(final.evidence.kind, 'succeeded'); assert.equal(pulls, 1);
const inspected = await api.request('GET', imagePath + '/json'); assert.equal(inspected.status, 200); assert.ok(inspected.value.RepoDigests.includes(image));
const barrier = await native.observe(plan); assert.equal(barrier.status, 'owned'); assert.equal(barrier.barrier, true);
await journal.close(); await writeFile(join(directory, 'trace.json'), JSON.stringify(trace));
assert.equal((await api.request('DELETE', `/containers/${barrier.id}?force=true&v=true`)).status, 204);

const racePath = join(directory, 'race'); await mkdir(racePath, { mode: 0o700 }); const raceStartedAt = Date.now();
const racePlan = { ...plan, scope: { ...plan.scope, run: randomUUID(), step: 'late-create' }, deadline: raceStartedAt + 60000 };
const entered = Promise.withResolvers(); const release = Promise.withResolvers();
const delayed = oneShotJob({ request: async (...args) => {
  if (args[1].startsWith('/containers/create?')) { entered.resolve(); await release.promise; } return api.request(...args);
} });
const duplicate = delayed.create(racePlan, {}); await entered.promise;
const racePorts = { native, now: Date.now, read: async (digest) => { assert.equal(digest, jobPlanDigest(racePlan)); return racePlan; }, authorize: async () => true, materialize: async () => ({}) };
await writeFile(join(racePath, 'plan.json'), JSON.stringify(racePlan));
const raceJournal = await openJournal(racePath); const first = oneShotExecution(raceJournal, racePorts); await first.prepare(racePlan);
let captured; const raceTrace = [];
while (Date.now() < racePlan.deadline) {
  const value = await first.tick(); raceTrace.push({ at: Date.now(), value });
  if (value.phase === 'fencing') { captured = value; break; } assert.notEqual(value.phase, 'held'); await pause(100);
}
assert.ok(captured); assert.equal(captured.evidence.kind, 'succeeded'); await raceJournal.close();
const fencer = oneShotJob({ request: async (...args) => {
  const result = await api.request(...args);
  if (args[0] === 'DELETE') { release.resolve(); assert.equal(await duplicate, 'acknowledged'); }
  return result;
} });
const reopened = await openJournal(racePath, 'existing'); const recovered = oneShotExecution(reopened, { ...racePorts, native: fencer });
await recovered.tick(); const late = await native.observe(racePlan); assert.equal(late.status, 'owned'); assert.equal(late.barrier, false); assert.notEqual(late.id, captured.container);
let raceFinal;
while (Date.now() < racePlan.deadline + 30000) {
  const value = await recovered.tick(); raceTrace.push({ at: Date.now(), value }); assert.notEqual(value.phase, 'held');
  if (value.phase === 'complete') { raceFinal = value; break; } await pause(100);
}
assert.ok(raceFinal); assert.deepEqual(raceFinal.fenceTargets, [late.id]); assert.deepEqual(raceFinal.evidence, captured.evidence);
const raceBarrier = await native.observe(racePlan); assert.equal(raceBarrier.status, 'owned'); assert.equal(raceBarrier.barrier, true);
const events = (await run('docker', ['events', '--since', String(Math.floor(raceStartedAt / 1000)), '--until', String(Math.floor(Date.now() / 1000) + 1),
  '--filter', 'label=com.kayra.job=' + jobName(racePlan.scope), '--format', '{{json .}}'], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout;
await writeFile(join(racePath, 'events.jsonl'), events); await writeFile(join(racePath, 'trace.json'), JSON.stringify(raceTrace));
const starts = events.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.Action === 'start');
assert.equal(starts.length, 1); assert.equal(starts[0].Actor.ID, captured.container); await reopened.close();
assert.equal((await api.request('DELETE', `/containers/${raceBarrier.id}?force=true&v=true`)).status, 204);
// Only the fresh, unregistered probe namespace is untagged; original and managed references stay untouched.
assert.equal((await api.request('DELETE', imagePath)).status, 200);
assert.equal((await api.request('GET', `/images/${encodeURIComponent(sourceImage)}/json`)).status, 200);
const version = await api.request('GET', '/version'); const result = { passed: true, app, image, sourceImage, engine: version.value.Version, api: version.value.ApiVersion,
  node: process.version, initiallyAbsent: true, pulls, executedDigestVerified: true, deadlineUnchanged: final.deadline === plan.deadline, barrierRemoved: true, originalReferencePreserved: true,
  lateCreateFenced: true, originalEvidencePreserved: true, lateContainerStarts: 0, originalContainerStarts: starts.length,
  scope: 'isolated unregistered job image preparation; no managed image removal or migration admission' };
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
