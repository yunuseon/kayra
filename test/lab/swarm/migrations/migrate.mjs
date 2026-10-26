import { createHash } from 'node:crypto';
import pg from 'pg';

const name = process.env.MIGRATION ?? 'expand';
const queries = {
  expand: ['ALTER TABLE items ADD COLUMN nickname text'],
  broken: ['ALTER TABLE items ADD COLUMN nickname text', 'SELECT 1 / 0'],
  contract: ['LOCK TABLE items IN ACCESS EXCLUSIVE MODE', 'UPDATE items SET nickname = display_name', 'ALTER TABLE items DROP COLUMN display_name'],
};
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, statement_timeout: 20000 });
const event = (kind, fields = {}) => console.log(JSON.stringify({ at: Date.now(), kind, migration: name, ...fields }));
let transaction = false;
try {
  await client.connect();
  await client.query('BEGIN');
  transaction = true;
  if (name === 'hold-read-lock') {
    await client.query('SELECT * FROM items LIMIT 1');
    event('read-lock-held');
    await client.query('SELECT pg_sleep(8)');
  } else {
    const checksum = createHash('sha256').update(JSON.stringify(queries[name])).digest('hex');
    await client.query("SET LOCAL lock_timeout = '20s'");
    await client.query('SELECT pg_advisory_xact_lock(724917)');
    event('migration-lock-held');
    await client.query("SET LOCAL lock_timeout = '500ms'");
    const previous = await client.query('SELECT checksum FROM schema_migrations WHERE version = $1', [name]);
    if (previous.rows.length) {
      if (previous.rows[0].checksum !== checksum) throw new Error('migration checksum changed');
      event('already-applied');
    } else {
      if (Number(process.env.HOLD_BEFORE_MS) > 0) await client.query('SELECT pg_sleep($1)', [Number(process.env.HOLD_BEFORE_MS) / 1000]);
      for (const query of queries[name]) await client.query(query);
      await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [name, checksum]);
      event('applied');
    }
  }
  await client.query('COMMIT');
  transaction = false;
  event('committed');
  if (Number(process.env.HOLD_AFTER_COMMIT_MS) > 0) await client.query('SELECT pg_sleep($1)', [Number(process.env.HOLD_AFTER_COMMIT_MS) / 1000]);
} catch (error) {
  if (transaction) await client.query('ROLLBACK').catch(() => {});
  event('failed', { code: error.code ?? error.message });
  process.exitCode = 1;
} finally { await client.end(); }
