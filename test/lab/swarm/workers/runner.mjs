import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMigrations } from '../migrations/runner.mjs';
import { assessWorker, workerScenarios, workerVerdict } from './results.mjs';
const directory = dirname(fileURLToPath(import.meta.url));
export const scenarios = workerScenarios;
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const query = async (ctx, sql) => (await ctx.docker(['exec', '-e', 'PGPASSWORD=lab-only-password', 'lab-db', 'psql', '-h', '127.0.0.1', '-U', 'lab', '-d', 'lab', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql])).stdout.trim();
const rows = async (ctx, sql) => JSON.parse(await query(ctx, `SELECT coalesce(json_agg(t),'[]') FROM (${sql}) t`));
async function until(ctx, read, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await ctx.sleep(250); }
  throw new Error(`${label} exceeded ${timeout}ms`);
}
export async function prepareWorkers(ctx) {
  // Reuse the pinned PostgreSQL, locked pg dependency and isolated data network.
  await prepareMigrations(ctx);
  ctx.metadata.workerSourceHashes = Object.fromEntries(['fixture.mjs', 'runner.mjs', 'results.mjs'].map((name) => [name, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')]));
  await ctx.run('multipass', ['transfer', join(directory, 'fixture.mjs'), `${ctx.metadata.vm}:/home/ubuntu/swarm-lab/migrations/fixture.mjs`]);
  ctx.metadata.images.workerFixture = `kayra-swarm-worker:${ctx.metadata.vm.replace('kayra-swarm-lab-', '')}`;
  await ctx.docker(['build', '-t', ctx.metadata.images.workerFixture, '/home/ubuntu/swarm-lab/migrations'], { timeout: 600000 });
  ctx.metadata.imageInspections.push(...await ctx.parseRemote(['image', 'inspect', ctx.metadata.images.workerFixture]));
}
async function remove(ctx) {
  await ctx.docker(['service', 'rm', 'probe'], { allowFailure: true });
  await until(ctx, async () => !(await ctx.docker(['ps', '-q', '--filter', 'label=com.docker.swarm.service.name=probe'])).stdout.trim(), 'previous worker shutdown', 45000);
}
async function reset(ctx, scenario) {
  await remove(ctx);
  await query(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public;
    CREATE TABLE jobs(id integer PRIMARY KEY,duration_ms integer NOT NULL,state text NOT NULL DEFAULT 'pending',owner text,attempts integer NOT NULL DEFAULT 0,lease_until timestamptz);
    CREATE TABLE effects(job_id integer PRIMARY KEY, task text NOT NULL, attempt integer NOT NULL);
    CREATE TABLE raw_effects(id bigint GENERATED ALWAYS AS IDENTITY,job_id integer NOT NULL,task text NOT NULL,attempt integer NOT NULL);
    CREATE TABLE history(id bigint GENERATED ALWAYS AS IDENTITY,at timestamptz NOT NULL DEFAULT clock_timestamp(),kind text NOT NULL,task text NOT NULL,release text NOT NULL,job_id integer,attempt integer);
    CREATE TABLE ownership(task text PRIMARY KEY,release text NOT NULL,started_at timestamptz NOT NULL DEFAULT clock_timestamp(),ended_at timestamptz);
    CREATE TABLE ticks(id bigint GENERATED ALWAYS AS IDENTITY,at timestamptz NOT NULL DEFAULT clock_timestamp(),task text NOT NULL,release text NOT NULL);
  `);
  const singleton = scenario.startsWith('singleton');
  if (!singleton) await query(ctx, `INSERT INTO jobs(id,duration_ms) SELECT i, CASE WHEN i=0 THEN ${scenario === 'graceful-drain' ? 20000 : scenario === 'killed-worker' ? 6000 : 100} ELSE 100 END FROM generate_series(0,19) i`);
  await ctx.docker(['service', 'create', '--detach', '--name', 'probe', '--replicas', '1', '--no-resolve-image', '--network', 'lab-data', '--limit-memory', '128m', '--reserve-memory', '32m',
    '--update-order', 'start-first', '--update-monitor', '30s', '--update-failure-action', 'rollback', '--update-max-failure-ratio', '0', '--stop-grace-period', '30s', '--restart-delay', '1s',
    '--health-cmd', 'node /app/fixture.mjs health', '--health-interval', '1s', '--health-timeout', '1s', '--health-retries', '2',
    '--env', 'DATABASE_URL=postgres://lab:lab-only-password@lab-db:5432/lab', '--env', 'RELEASE=A', '--env', `MODE=${singleton ? 'singleton' : 'queue'}`,
    '--env', `LOCKED=${scenario !== 'singleton-unlocked'}`, '--env', `IDEMPOTENT=${scenario !== 'effect-without-idempotency'}`,
    '--env', `PAUSE_AFTER_EFFECT=${scenario.startsWith('effect-')}`, ctx.metadata.images.workerFixture]);
}
async function runCase(ctx, scenario, repeat, baseline = false) {
  const path = join(ctx.output, baseline ? 'baseline' : `${scenario}-${repeat}`);
  mkdirSync(path);
  ctx.progress(`workers ${baseline ? '30-second baseline' : `${scenario}/${repeat}`}`);
  await reset(ctx, scenario);
  await until(ctx, async () => (await rows(ctx, "SELECT * FROM history WHERE release='A' AND kind='started'")).length, 'A started');
  const before = (await ctx.parseRemote(['service', 'inspect', 'probe']))[0];
  const timeline = [];
  const mark = (kind, fields = {}) => timeline.push({ kind, at: Date.now(), ...fields });
  if (baseline) {
    await ctx.sleep(31000);
    await remove(ctx);
    const ticks = await rows(ctx, 'SELECT * FROM ticks ORDER BY id');
    save(join(path, 'ticks.json'), ticks);
    save(join(path, 'history.json'), await rows(ctx, 'SELECT * FROM history ORDER BY id'));
    const times = ticks.map((row) => Date.parse(row.at));
    if (times.length < 300 || times.at(-1) - times[0] < 30000 || times.some((at, index) => index && at - times[index-1] > 1000)) throw new Error('worker baseline interrupted or unhealthy');
    return;
  }
  const singleton = scenario.startsWith('singleton');
  const trigger = singleton ? 'acquired' : scenario.startsWith('effect-') ? 'before-ack-paused' : 'claimed';
  const initial = await until(ctx, async () => (await rows(ctx, `SELECT * FROM history WHERE release='A' AND kind='${trigger}' ${singleton ? '' : 'AND job_id=0'} ORDER BY id LIMIT 1`))[0], trigger);
  mark('fault-window-observed', { initial });
  let killed;
  if (scenario === 'killed-worker' || scenario.startsWith('effect-')) {
    const ids = (await ctx.docker(['ps', '-q', '--no-trunc', '--filter', 'label=com.docker.swarm.service.name=probe'])).stdout.trim().split('\n');
    killed = ids.find((id) => id.startsWith(initial.task));
    if (!killed) throw new Error('cannot identify exact worker for fault injection');
    mark('kill-submitted', { killed });
    await ctx.docker(['kill', '--signal', 'KILL', killed]);
    mark('kill-acknowledged');
  } else {
    mark('update-submitted');
    await ctx.docker(['service', 'update', '--detach', '--env-add', 'RELEASE=B', 'probe']);
    mark('update-acknowledged');
  }
  let completion;
  if (singleton) completion = await until(ctx, async () => (await rows(ctx, "SELECT * FROM history WHERE release='B' AND kind='acquired' ORDER BY id LIMIT 1"))[0], 'B singleton ownership');
  else completion = await until(ctx, async () => (await rows(ctx, "SELECT count(*) AS completed FROM jobs WHERE state='done'"))[0].completed === 20, 'all jobs acknowledged');
  mark('work-completed', { completion });
  if (!killed) await until(ctx, async () => {
    const service = (await ctx.parseRemote(['service', 'inspect', 'probe']))[0];
    return service.UpdateStatus?.State === 'completed';
  }, 'native update completed');
  await ctx.sleep(3000);
  const after = (await ctx.parseRemote(['service', 'inspect', 'probe']))[0];
  await ctx.snapshot(path);
  // End final ownership intervals so overlap can be computed with a common DB clock.
  await remove(ctx);
  const database = {};
  for (const table of ['jobs', 'effects', 'raw_effects', 'history', 'ownership', 'ticks']) database[table] = await rows(ctx, `SELECT * FROM ${table} ORDER BY ${table === 'effects' ? 'job_id' : table === 'ownership' ? 'started_at' : 'id'}`);
  const evidence = { scenario, repeat, before, after, initial, timeline, killed, database, finishedAt: Date.now() };
  save(join(path, 'evidence.json'), evidence);
  const result = assessWorker(evidence);
  ctx.results.push(result);
  save(join(path, 'result.json'), result);
  save(join(ctx.output, 'summary.json'), { ...ctx.metadata, verdict: workerVerdict(ctx.results), finishedAt: null });
  ctx.progress(`${scenario}/${repeat}: ${result.passed ? 'PASS' : 'FAIL'} ${result.reasons.join('; ')}`);
}
export async function runWorkers(ctx) {
  await runCase(ctx, 'singleton-locked', 0, true);
  for (let repeat = 1; repeat <= ctx.settings.repeats; repeat++) for (const scenario of ctx.settings.scenarios) await runCase(ctx, scenario, repeat);
}
