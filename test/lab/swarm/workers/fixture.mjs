import http from 'node:http';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';

if (process.argv[2] === 'health') {
  try { const response = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(800) }); process.exit(response.ok ? 0 : 1); }
  catch { process.exit(1); }
}
const task = hostname();
const release = process.env.RELEASE ?? 'A';
const mode = process.env.MODE ?? 'queue';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 1000, statement_timeout: 2000 });
let draining = false;
let ready = false;
const event = async (kind, job = null, attempt = null) => {
  await pool.query('INSERT INTO history(kind,task,release,job_id,attempt) VALUES($1,$2,$3,$4,$5)', [kind, task, release, job, attempt]);
  console.log(JSON.stringify({ at: Date.now(), kind, task, release, job, attempt }));
};
const server = http.createServer((req, res) => { res.writeHead(ready ? 200 : 503); res.end(JSON.stringify({ task, release, ready, draining })); });
server.listen(8080, '0.0.0.0');
process.on('SIGTERM', () => { draining = true; });
const guard = (job) => [job.id, task, job.attempts];

async function queue() {
  while (!draining) {
    // One atomic claim. Expired leases can be redelivered; attempts are fencing tokens.
    const { rows: [job] } = await pool.query(`WITH candidate AS (
      SELECT id FROM jobs WHERE state <> 'done' AND (lease_until IS NULL OR lease_until < clock_timestamp())
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE jobs j SET state='running', owner=$1, attempts=attempts+1, lease_until=clock_timestamp()+interval '4 seconds'
      FROM candidate c WHERE j.id=c.id RETURNING j.*`, [task]);
    if (!job) { await sleep(100); continue; }
    await event('claimed', job.id, job.attempts);
    let renewalError;
    let renewing = Promise.resolve();
    const timer = setInterval(() => {
      renewing = renewing.then(() => pool.query("UPDATE jobs SET lease_until=clock_timestamp()+interval '4 seconds' WHERE id=$1 AND owner=$2 AND attempts=$3 AND state='running'", guard(job))).catch((error) => { renewalError = error; });
    }, 800);
    try {
      await sleep(job.duration_ms);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const owned = await client.query("SELECT id FROM jobs WHERE id=$1 AND owner=$2 AND attempts=$3 AND lease_until>clock_timestamp() AND state='running' FOR UPDATE", guard(job));
        if (!owned.rowCount || renewalError) throw new Error('lost lease; refusing stale effect');
        if (process.env.IDEMPOTENT === 'false') await client.query('INSERT INTO raw_effects(job_id,task,attempt) VALUES($1,$2,$3)', guard(job));
        else await client.query('INSERT INTO effects(job_id,task,attempt) VALUES($1,$2,$3) ON CONFLICT(job_id) DO NOTHING', guard(job));
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      await event('effect-committed', job.id, job.attempts);
      if (process.env.PAUSE_AFTER_EFFECT === 'true' && job.id === 0 && job.attempts === 1) {
        await event('before-ack-paused', job.id, job.attempts);
        await sleep(20000);
      }
      const ack = await pool.query("UPDATE jobs SET state='done', lease_until=NULL WHERE id=$1 AND owner=$2 AND attempts=$3 AND state='running' AND lease_until>clock_timestamp() RETURNING id", guard(job));
      if (!ack.rowCount) throw new Error('lost lease before acknowledgement');
      await event('acknowledged', job.id, job.attempts);
    } finally { clearInterval(timer); await renewing; }
  }
  await event('drained');
}

async function singleton() {
  const client = await pool.connect();
  const locked = process.env.LOCKED !== 'false';
  let acquired = false;
  try {
    while (!draining) {
      acquired = !locked || (await client.query('SELECT pg_try_advisory_lock(724918) AS acquired')).rows[0].acquired;
      if (acquired) break;
      await event('standby');
      await sleep(200);
    }
    if (!acquired) return;
    await client.query('INSERT INTO ownership(task,release) VALUES($1,$2)', [task, release]);
    await event('acquired');
    while (!draining) {
      await client.query('INSERT INTO ticks(task,release) VALUES($1,$2)', [task, release]);
      await sleep(100);
    }
    // Deliberate five-second in-flight exclusive operation, still owning the session lock.
    await event('singleton-draining');
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      await client.query('INSERT INTO ticks(task,release) VALUES($1,$2)', [task, release]);
      await sleep(100);
    }
    await client.query('UPDATE ownership SET ended_at=clock_timestamp() WHERE task=$1', [task]);
    await event('released');
    if (locked) await client.query('SELECT pg_advisory_unlock(724918)');
  } finally { client.release(); }
}

try {
  await pool.query('SELECT 1');
  await event('started');
  ready = true; // A singleton standby is healthy; ownership is separate from process readiness.
  await (mode === 'singleton' ? singleton() : queue());
  ready = false;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
} catch (error) { console.error(error); process.exit(42); }
