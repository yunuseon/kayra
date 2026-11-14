import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { healthCommand } from './migration-fixture.mjs';

const run = promisify(execFile);
test('the unsafe app fixture applies before failing and its declared probe reports the same logical operation', async (t) => {
  const calls = new Map();
  const server = createServer((incoming, response) => {
    const operation = incoming.headers['x-operation']; assert.equal(operation, '11111111-1111-4111-8111-111111111111:schema');
    response.setHeader('content-type', 'application/json');
    if (incoming.method === 'POST') { calls.set(operation, (calls.get(operation) ?? 0) + 1); response.end(JSON.stringify({ effects: calls.get(operation) })); }
    else response.end(JSON.stringify({ version: 1, outcome: calls.has(operation) ? 'applied' : 'not-applied' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, DB_HOST: '127.0.0.1', DB_PORT: String(server.address().port), KAYRA_OPERATION_ID: '11111111-1111-4111-8111-111111111111:schema', FAIL_AFTER_EFFECT: 'true', MIGRATION_HOLD_MS: '0' };
  const script = new URL('./complete-fixture/web/migration.mjs', import.meta.url);
  await assert.rejects(run(process.execPath, [fileURLToPath(script), 'apply'], { env }), (error) => error.code === 1); assert.equal(calls.get(env.KAYRA_OPERATION_ID), 1);
  const probe = await run(process.execPath, [fileURLToPath(script), 'probe'], { env }); assert.deepEqual(JSON.parse(probe.stdout), { version: 1, outcome: 'applied' }); assert.equal(calls.get(env.KAYRA_OPERATION_ID), 1);
  await assert.rejects(run(process.execPath, [fileURLToPath(script), 'apply'], { env }), (error) => error.code === 1); assert.equal(calls.get(env.KAYRA_OPERATION_ID), 2);
});

test('fixture health mode checks readiness without loading the fetch runtime or starting another server', async (t) => {
  let status = 503;
  const server = createServer((_incoming, response) => { response.writeHead(status); response.end('{}'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, PORT: String(server.address().port) };
  status = 503; await assert.rejects(run(process.execPath, healthCommand.slice(1), { env }), (error) => error.code === 1);
  status = 200; await run(process.execPath, healthCommand.slice(1), { env });
  for (const fixture of ['http-fixture', 'complete-fixture']) {
    const script = fileURLToPath(new URL('./' + fixture + '/web/fixture.mjs', import.meta.url));
    status = 503; await assert.rejects(run(process.execPath, [script, 'health'], { env }), (error) => error.code === 1);
    status = 200; const ready = await run(process.execPath, [script, 'health'], { env }); assert.equal(ready.stdout, '');
  }
});
