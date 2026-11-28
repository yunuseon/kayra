import http from 'node:http';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (process.argv[2] === 'health') {
  try {
    const response = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(800) });
    process.exit(response.ok ? 0 : 1);
  } catch { process.exit(1); }
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6, connectionTimeoutMillis: 800, statement_timeout: 1000 });
const mode = process.env.SCHEMA_MODE ?? 'legacy';
const release = process.env.RELEASE ?? 'A';
const task = os.hostname();
const startedAt = Date.now();
let draining = false;
let armed = false;
const event = (kind, fields = {}) => console.log(JSON.stringify({ at: Date.now(), kind, release, task, ...fields }));
const expression = mode === 'legacy' ? 'display_name' : mode === 'dual' ? 'coalesce(nickname, display_name)' : 'nickname';
const server = http.createServer(async (request, response) => {
  const requestStartedAt = Date.now();
  const health = request.url === '/health';
  const body = { release, task, startedAt, readyAt: startedAt, requestStartedAt, ready: !draining, mode };
  let status = 200;
  try {
    const canary = await pool.query(`SELECT ${expression} AS value FROM items WHERE id = 'seed'`);
    body.canary = canary.rows[0]?.value;
    if (body.canary !== 'seed-value') throw new Error('canary corrupted');
    if (!health) {
      const id = randomUUID();
      const value = `value-${id}`;
      const columns = mode === 'legacy' ? 'id, display_name' : mode === 'dual' ? 'id, display_name, nickname' : 'id, nickname';
      const values = mode === 'dual' ? '$1, $2, $2' : '$1, $2';
      const result = await pool.query(`INSERT INTO items (${columns}) VALUES (${values}) RETURNING ${expression} AS value`, [id, value]);
      body.writeId = id;
      body.value = result.rows[0].value;
    }
    if (health && !draining && !armed && Number(process.env.FAIL_AFTER_HEALTH_MS) > 0) {
      armed = true;
      event('fault-armed');
      setTimeout(() => { event('crash'); process.exit(42); }, Number(process.env.FAIL_AFTER_HEALTH_MS));
    }
  } catch (error) {
    status = 503;
    body.ready = false;
    body.error = error.code ?? error.message;
    event('database-error', { code: body.error, health });
  }
  if (health && draining) status = 503;
  if (draining) response.shouldKeepAlive = false;
  response.once('finish', () => { if (draining) setImmediate(() => server.closeIdleConnections()); });
  response.writeHead(status, { 'content-type': 'application/json', ...(draining ? { connection: 'close' } : {}) });
  response.end(JSON.stringify(body));
});
server.listen(8080, '0.0.0.0', () => event('listening'));
process.on('SIGTERM', () => {
  draining = true;
  event('terminating');
  server.close(async () => { await pool.end(); event('closed'); process.exit(0); });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 29000).unref();
});
