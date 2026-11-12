import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jobPlanDigest } from '../../../cli/src/contracts/one-shot-job.ts';
import { oneShotExecution } from '../../../cli/src/server/deployment/one-shot-execution.ts';
import { openJournal } from '../../../cli/src/server/deployment/journal.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { oneShotJob } from '../../../cli/src/server/runtime/one-shot-job.ts';

const [directory, image] = process.argv.slice(2); assert.ok(directory); assert.match(image, /^localhost:5000\/[a-z][a-z0-9-]{0,47}\/web@sha256:[0-9a-f]{64}$/);
const app = image.split('/')[1]; const api = dockerApi(); const native = oneShotJob(api); const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const privateValue = 'synthetic-probe-private-value'; const reports = [];
const cases = [
  ...['applied', 'not-applied', 'unknown'].map((outcome) => ({ name: outcome, command: `printf '%s\\n' '${JSON.stringify({ version: 1, outcome })}'`, expected: outcome, exit: 0 })),
  { name: 'private-malformed', command: 'printf "%s\\n" "$TOKEN"', expected: 'unknown', exit: 0 },
  { name: 'oversized', command: 'head -c 2048 /dev/zero', expected: 'unknown', exit: 0 },
  { name: 'failed', command: 'printf \'%s\\n\' \'{"version":1,"outcome":"applied"}\'; exit 1', expected: null, exit: 1 },
];
await mkdir(directory, { mode: 0o700 });
for (const item of cases) {
  const path = join(directory, item.name); await mkdir(path, { mode: 0o700 });
  const plan = { version: 1, scope: { app, incarnation: randomUUID(), run: randomUUID(), step: 'schema', purpose: 'probe', attempt: 1 }, image,
    command: ['sh', '-c', item.command], entrypoint: null, environment: { TOKEN: { kind: 'secret', key: 'TOKEN' } },
    resources: { memoryBytes: 64 * 1024 * 1024, nanoCpus: 100_000_000 }, networks: [], deadline: Date.now() + 60000, stopGraceSeconds: 30,
  };
  await writeFile(join(path, 'plan.json'), JSON.stringify(plan));
  const journal = await openJournal(path); const owner = oneShotExecution(journal, { native, now: Date.now, read: async (digest) => { assert.equal(digest, jobPlanDigest(plan)); return plan; },
    authorize: async () => true, materialize: async () => ({ TOKEN: privateValue }) });
  await owner.prepare(plan); let final; const trace = [];
  while (Date.now() < plan.deadline + 30000) {
    const value = await owner.tick(); trace.push({ at: Date.now(), value }); assert.notEqual(value.phase, 'held');
    if (value.phase === 'complete') { final = value; break; } await pause(100);
  }
  assert.ok(final); assert.equal(final.evidence.exitCode, item.exit); assert.equal(final.evidence.probe, item.expected);
  assert.equal(final.evidence.kind, item.exit === 0 ? 'succeeded' : 'failed');
  await writeFile(join(path, 'trace.json'), JSON.stringify(trace));
  assert.ok(!(await readFile(join(path, 'state.json'), 'utf8')).includes(privateValue)); assert.ok(!JSON.stringify(trace).includes(privateValue));
  const barrier = await native.observe(plan); assert.equal(barrier.status, 'owned'); assert.equal(barrier.barrier, true); assert.equal(barrier.state, 'created');
  assert.ok(!JSON.stringify(barrier).includes(privateValue)); await journal.close();
  assert.equal((await api.request('DELETE', `/containers/${barrier.id}?force=true&v=true`)).status, 204);
  reports.push({ name: item.name, evidence: final.evidence, barrierRemoved: true, privateValuesPersisted: false });
  console.log(JSON.stringify(reports.at(-1)));
}
const version = await api.request('GET', '/version');
await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, engine: version.value.Version, api: version.value.ApiVersion, node: process.version, image,
  scope: 'isolated status-probe execution and normalized evidence, without migration rollout integration', reports }, null, 2));
