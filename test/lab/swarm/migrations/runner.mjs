import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { traffic } from '../probe.mjs';
import { settlement, trafficEvidence } from '../results.mjs';
import { assessMigration, migrationVerdict, migrationScenarios } from './results.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
export const scenarios = migrationScenarios;
const databaseUrl = 'postgres://lab:lab-only-password@lab-db:5432/lab';
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const parseLines = (raw) => raw.split('\n').flatMap((line) => { try { return [JSON.parse(line.slice(line.indexOf('{')))]; } catch { return []; } });
const query = async (ctx, sql) => (await ctx.docker(['exec', '-e', 'PGPASSWORD=lab-only-password', 'lab-db', 'psql', '-h', '127.0.0.1', '-U', 'lab', '-d', 'lab', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql])).stdout.trim();

export async function prepareMigrations(ctx) {
  const { metadata, docker, remote, run, pull, sleep } = ctx;
  metadata.migrationSourceHashes = Object.fromEntries(['runner.mjs', 'results.mjs', 'fixture.mjs', 'migrate.mjs', 'images.json', 'package.json', 'package-lock.json'].map((name) => [name, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')]));
  metadata.images.postgres = JSON.parse(readFileSync(join(directory, 'images.json'), 'utf8')).postgres;
  metadata.images.databaseFixture = `kayra-swarm-db-probe:${metadata.vm.replace('kayra-swarm-lab-', '')}`;
  await pull(metadata.images.postgres);
  await remote(['mkdir', '-p', '/home/ubuntu/swarm-lab/migrations']);
  for (const name of ['fixture.mjs', 'migrate.mjs', 'package.json', 'package-lock.json']) await run('multipass', ['transfer', join(directory, name), `${metadata.vm}:/home/ubuntu/swarm-lab/migrations/${name}`]);
  await remote(['tee', '/home/ubuntu/swarm-lab/migrations/Dockerfile'], { input: `FROM ${metadata.images.node}\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev --ignore-scripts\nCOPY *.mjs ./\nUSER node\nCMD ["node", "/app/fixture.mjs"]\n` });
  await docker(['build', '-t', metadata.images.databaseFixture, '/home/ubuntu/swarm-lab/migrations'], { timeout: 600000 });
  await docker(['network', 'create', '--driver', 'overlay', '--attachable', 'lab-data']);
  await docker(['volume', 'create', 'lab-db-data']);
  await docker(['run', '-d', '--name', 'lab-db', '--network', 'lab-data', '--memory', '512m', '-v', 'lab-db-data:/var/lib/postgresql', '-e', 'POSTGRES_USER=lab', '-e', 'POSTGRES_PASSWORD=lab-only-password', '-e', 'POSTGRES_DB=lab', metadata.images.postgres, '-c', 'log_lock_waits=on']);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { ready = await query(ctx, 'SELECT 1') === '1'; } catch {}
    if (ready) break;
    await sleep(1000);
  }
  if (!ready) throw new Error('PostgreSQL did not start');
  metadata.versions.postgres = await query(ctx, 'SELECT version()');
  metadata.versions.databaseDriver = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).dependencies;
  metadata.imageInspections.push(...await ctx.parseRemote(['image', 'inspect', metadata.images.postgres, metadata.images.databaseFixture]));
}

async function reset(ctx) {
  await ctx.docker(['service', 'rm', 'probe'], { allowFailure: true });
  const deadline = Date.now() + 45000;
  while ((await ctx.docker(['ps', '-q', '--filter', 'label=com.docker.swarm.service.name=probe'])).stdout.trim()) {
    if (Date.now() > deadline) throw new Error('previous application tasks did not stop');
    await ctx.sleep(500);
  }
  await query(ctx, "DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE items (id text PRIMARY KEY, display_name text NOT NULL); INSERT INTO items VALUES ('seed', 'seed-value'); CREATE TABLE schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());");
  await ctx.docker(['service', 'create', '--detach', '--name', 'probe', '--replicas', '1', '--no-resolve-image', '--network', 'lab-public', '--network', 'lab-data',
    '--limit-memory', '128m', '--reserve-memory', '32m', '--update-order', 'start-first', '--update-monitor', '30s', '--update-failure-action', 'rollback', '--update-max-failure-ratio', '0', '--rollback-order', 'start-first', '--rollback-monitor', '5s', '--stop-grace-period', '30s', '--restart-delay', '1s',
    '--health-cmd', 'node /app/fixture.mjs health', '--health-interval', '1s', '--health-timeout', '1s', '--health-retries', '2', '--health-start-period', '20s',
    '--env', `DATABASE_URL=${databaseUrl}`, '--env', 'RELEASE=A', '--env', 'SCHEMA_MODE=legacy', '--env', 'FAIL_AFTER_HEALTH_MS=0',
    '--label', 'traefik.enable=true', '--label', 'traefik.swarm.network=lab-public', '--label', 'traefik.swarm.lbswarm=true', '--label', 'traefik.http.routers.probe.rule=Host(`probe.swarm-lab.test`)', '--label', 'traefik.http.routers.probe.entrypoints=web', '--label', 'traefik.http.routers.probe.service=probe', '--label', 'traefik.http.services.probe.loadbalancer.server.port=8080', ctx.metadata.images.databaseFixture]);
  return await ctx.waitForA();
}

async function databaseState(ctx) {
  const columns = JSON.parse(await query(ctx, "SELECT json_agg(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'items'"));
  const ledger = JSON.parse(await query(ctx, "SELECT coalesce(json_agg(t), '[]') FROM (SELECT * FROM schema_migrations ORDER BY version) t"));
  const rows = JSON.parse(await query(ctx, "SELECT coalesce(json_agg(t), '[]') FROM (SELECT * FROM items ORDER BY id) t"));
  return { columns, ledger, rows };
}

async function runCase(ctx, scenario, repeat) {
  const path = join(ctx.output, `vip-${scenario}-${repeat}`);
  mkdirSync(path);
  ctx.progress(`migrations ${scenario}/${repeat}`);
  const initial = await reset(ctx);
  save(join(path, 'initial-task.json'), initial);
  const before = (await ctx.parseRemote(['service', 'inspect', 'probe']))[0];
  const records = [];
  const { appendFileSync } = await import('node:fs');
  const timeline = [];
  const record = (row) => { records.push(row); appendFileSync(join(path, 'requests.ndjson'), `${JSON.stringify(row)}\n`); };
  const mark = (kind, fields = {}) => { const row = { at: Date.now(), kind, ...fields }; timeline.push(row); appendFileSync(join(path, 'timeline.ndjson'), `${JSON.stringify(row)}\n`); };
  const stop = traffic(`${ctx.target}/version`, record);
  const migrations = [];
  let sequence = 0;
  const startMigration = async (migration, env = {}) => {
    const name = `migration-${repeat}-${scenario}-${sequence++}`;
    const id = (await ctx.docker(['run', '-d', '--name', name, '--network', 'lab-data', '--memory', '128m', '-e', `DATABASE_URL=${databaseUrl}`, '-e', `MIGRATION=${migration}`, ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), ctx.metadata.images.databaseFixture, 'node', '/app/migrate.mjs'])).stdout.trim();
    mark('migration-started', { migration, id });
    return { id, migration };
  };
  const finishMigration = async (attempt) => {
    await ctx.docker(['wait', attempt.id], { timeout: 60000 });
    const inspection = (await ctx.parseRemote(['inspect', attempt.id]))[0];
    const logs = await ctx.docker(['logs', attempt.id], { allowFailure: true });
    const result = { ...attempt, exitCode: inspection.State.ExitCode, startedAt: Date.parse(inspection.State.StartedAt), finishedAt: Date.parse(inspection.State.FinishedAt), events: parseLines(logs.stdout) };
    migrations.push(result);
    save(join(path, `migration-${attempt.id}.json`), { ...result, inspection });
    writeFileSync(join(path, `migration-${attempt.id}.log`), logs.stdout + logs.stderr);
    mark('migration-finished', { id: attempt.id, exitCode: result.exitCode });
    return result;
  };
  const migrate = async (migration, env) => await finishMigration(await startMigration(migration, env));
  const awaitEvent = async (attempt, kind) => {
    for (let i = 0; i < 30; i++) {
      const logs = await ctx.docker(['logs', attempt.id]);
      if (parseLines(logs.stdout).some((row) => row.kind === kind)) return;
      await ctx.sleep(250);
    }
    throw new Error(`migration never reached ${kind}`);
  };
  const waitRuntime = async (expected, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    let state;
    do {
      const service = (await ctx.parseRemote(['service', 'inspect', 'probe']))[0];
      state = { state: service.UpdateStatus?.State ?? 'none', observedAt: Date.now(), message: service.UpdateStatus?.Message };
      mark('runtime', state);
      if (state.state === expected || ['paused', 'rollback_paused'].includes(state.state)) return state;
      await ctx.sleep(1000);
    } while (Date.now() < deadline);
    return { ...state, deadline: true };
  };
  const update = async (mode = 'dual', crash = false) => {
    mark('update-submitted', { mode, crash });
    await ctx.docker(['service', 'update', '--detach', '--env-add', 'RELEASE=B', '--env-add', `SCHEMA_MODE=${mode}`, '--env-add', `FAIL_AFTER_HEALTH_MS=${crash ? 5000 : 0}`, 'probe']);
    return await waitRuntime(crash ? 'rollback_completed' : 'completed');
  };
  const rollback = async (timeout) => {
    mark('rollback-submitted');
    await ctx.docker(['service', 'rollback', '--detach', 'probe']);
    return await waitRuntime('rollback_completed', timeout);
  };
  let intermediate;
  let outcome;
  let updateAt;
  let legacyCompatibility;
  let candidateOutcome;
  try {
    await ctx.sleep(5000);
    updateAt = Date.now();
    mark('experiment-started');
    if (scenario === 'transaction-failure') {
      await migrate('broken');
    } else if (scenario === 'concurrent-migrations') {
      const first = await startMigration('expand', { HOLD_BEFORE_MS: 5000 });
      await awaitEvent(first, 'migration-lock-held');
      const second = await startMigration('expand');
      await Promise.all([finishMigration(first), finishMigration(second)]);
    } else if (scenario === 'interrupted-before-commit' || scenario === 'interrupted-after-commit') {
      const after = scenario === 'interrupted-after-commit';
      const attempt = await startMigration('expand', after ? { HOLD_AFTER_COMMIT_MS: 15000 } : { HOLD_BEFORE_COMMIT_MS: 15000 });
      await awaitEvent(attempt, after ? 'committed' : 'before-commit-paused');
      await ctx.docker(['kill', '--signal', 'KILL', attempt.id]);
      await finishMigration(attempt);
      intermediate = await databaseState(ctx);
      save(join(path, 'database-after-interruption.json'), intermediate);
      await migrate('expand');
    } else if (scenario === 'lock-contention') {
      const blocker = await startMigration('hold-read-lock');
      await awaitEvent(blocker, 'read-lock-held');
      await migrate('expand');
      await finishMigration(blocker);
    } else {
      const expanded = await migrate('expand');
      if (expanded.exitCode !== 0) throw new Error('required expansion migration failed');
      if (scenario === 'destructive-rollback') {
        const contracted = await migrate('contract');
        if (contracted.exitCode !== 0) throw new Error('negative-control contract migration failed');
        candidateOutcome = await update('contracted');
        save(join(path, 'candidate-outcome.json'), candidateOutcome);
        outcome = await rollback(35000);
        const check = await ctx.docker(['exec', '-e', 'PGPASSWORD=lab-only-password', 'lab-db', 'psql', '-U', 'lab', '-d', 'lab', '-X', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-c', 'SELECT display_name FROM items LIMIT 1'], { allowFailure: true });
        legacyCompatibility = { exitCode: check.code, stdout: check.stdout, stderr: check.stderr };
      } else if (scenario === 'candidate-crash') {
        outcome = await update('dual', true);
      } else {
        candidateOutcome = await update();
        save(join(path, 'candidate-outcome.json'), candidateOutcome);
        outcome = await rollback();
      }
    }
    outcome ??= { state: 'not-updated', observedAt: Date.now() };
    const expected = scenario === 'destructive-rollback' ? 'B' : 'A';
    const tailDeadline = Date.now() + 70000;
    while (!settlement(records, outcome, expected).stable && Date.now() < tailDeadline) await ctx.sleep(500);
  } finally {
    await stop();
    await ctx.snapshot(path);
    await ctx.docker(['logs', '--timestamps', 'lab-db'], { allowFailure: true, log: join(path, 'postgres.log') });
  }
  const after = (await ctx.parseRemote(['service', 'inspect', 'probe']))[0];
  const database = await databaseState(ctx);
  const evidence = { mode: 'vip', scenario, repeat, updateAt, finishedAt: Date.now(), outcome, before, after, migrations, intermediate, legacyCompatibility, candidateOutcome, timeline, database };
  save(join(path, 'evidence.json'), evidence);
  const result = { ...evidence, before: undefined, after: undefined, database: undefined, intermediate: undefined, ...assessMigration(evidence, records) };
  ctx.results.push(result);
  save(join(path, 'result.json'), result);
  save(join(ctx.output, 'summary.json'), { ...ctx.metadata, verdict: migrationVerdict(ctx.results), finishedAt: null });
  ctx.progress(`migrations ${scenario}/${repeat}: ${result.passed ? 'PASS' : 'FAIL'} (${result.failedRequests}/${result.requests} failures; ${result.retention.acknowledged} acknowledged writes verified)`);
  if (!result.traffic.passed) throw new Error('migration load generator interrupted or too slow; measurement invalid');
}

export async function runMigrations(ctx) {
  ctx.progress('migrations: 30-second read/write baseline');
  await reset(ctx);
  const records = [];
  const { appendFileSync } = await import('node:fs');
  const stop = traffic(`${ctx.target}/version`, (row) => { records.push(row); appendFileSync(join(ctx.output, 'baseline-vip.ndjson'), `${JSON.stringify(row)}\n`); });
  try { await ctx.sleep(31000); } finally { await stop(); }
  if (!trafficEvidence(records).passed || records.some((row) => row.error || row.status !== 200 || row.body?.canary !== 'seed-value')) throw new Error('database read/write baseline invalid');
  for (let repeat = 1; repeat <= ctx.settings.repeats; repeat++) for (const scenario of ctx.settings.scenarios) await runCase(ctx, scenario, repeat);
}
