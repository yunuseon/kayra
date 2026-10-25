import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { isCurrentTask, request } from './probe.mjs';
import { assess, verdict } from './results.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const sample = (at, release = 'B', fields = {}) => ({ kind: 'short', at, endedAt: at + 5, latencyMs: 5, status: 200, body: { release, ready: true, readyAt: 0, requestStartedAt: at }, ...fields });
const passing = (scenario = 'healthy') => ({
  scenario, updateAt: 1000, outcome: { state: 'completed', observedAt: 2000 },
  records: Array.from({ length: 600 }, (_, i) => sample(2100 + i * 50)),
});

test('case readiness rejects a previous service task with the same release label', () => {
  const response = { status: 200, body: { release: 'A', ready: true, task: 'aaaaaaaaaaaa' } };
  assert.equal(isCurrentTask(response, ['bbbbbbbbbbbb0123456789']), false);
  assert.equal(isCurrentTask(response, ['aaaaaaaaaaaa0123456789']), true);
});

test('assessment rejects lost requests, early exposure, wrong tails and late recovery', () => {
  assert.equal(assess(passing()).passed, true);
  const lost = passing();
  lost.records[10] = sample(2600, 'B', { error: 'ECONNRESET', status: undefined });
  assert.equal(assess(lost).passed, false);
  const early = passing();
  early.records.unshift(sample(1500, 'B', { body: { release: 'B', ready: false, readyAt: 1800, requestStartedAt: 1500 } }));
  assert.equal(assess(early).prematureRequests, 1);
  const wrong = passing();
  wrong.records[100].body.release = 'A';
  assert.equal(assess(wrong).passed, false);
  assert.equal(assess({ ...passing(), outcome: { state: 'completed', observedAt: 92000 } }).passed, false);
});

test('recovery reports disruption without treating it as uninterrupted continuity', () => {
  const input = passing('crash-after-ready');
  input.outcome.state = 'rollback_completed';
  input.records.forEach((row) => { row.body.release = 'A'; });
  input.records.unshift(sample(1500, 'B', { error: 'ECONNRESET', status: undefined }));
  const result = assess(input);
  assert.equal(result.passed, true);
  assert.equal(result.failedRequests, 1);
  assert.ok(result.longestObservedFailureIntervalMs > 0);
  assert.equal(assess({ ...input, scenario: 'never-ready' }).passed, false);
});

test('a draining request is not mislabeled premature, but an unready candidate is', () => {
  const input = passing();
  input.records.unshift(sample(1500, 'A', { body: { release: 'A', ready: false, readyAt: 100, requestStartedAt: 1500 } }));
  assert.equal(assess(input).prematureRequests, 0);
  input.records.unshift(sample(1500, 'B', { body: { release: 'B', ready: false, readyAt: null, requestStartedAt: 1500 } }));
  assert.equal(assess(input).prematureRequests, 1);
});

test('long requests and observer interruption require positive evidence', () => {
  assert.equal(assess(passing('long-request')).passed, false);
  assert.equal(assess({ ...passing('long-request'), longRequest: sample(1000, 'A') }).passed, true);
  assert.equal(assess(passing('observer-interruption')).passed, false);
  assert.equal(assess({ ...passing('observer-interruption'), observer: { reconstructed: true } }).passed, true);
});

test('partial runs cannot establish a feasible discovery mode', () => {
  assert.equal(verdict([{ mode: 'vip', scenario: 'healthy', repeat: 1, passed: true }]).viable, false);
  const scenarios = ['healthy', 'slow-ready', 'never-ready', 'crash-after-ready', 'long-request', 'observer-interruption'];
  const rows = scenarios.flatMap((scenario) => [1, 2, 3].map((repeat) => ({ mode: 'vip', scenario, repeat, passed: true })));
  assert.equal(verdict(rows).viable, true);
  assert.equal(verdict(rows).complete, false);
  rows[0].passed = false;
  assert.equal(verdict(rows).viable, false);
});

async function fixture(t, env = {}) {
  const child = spawn(process.execPath, [join(directory, 'fixture.mjs')], { env: { ...process.env, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let buffer = '';
  const listening = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.once('exit', (code) => reject(new Error(`fixture exited before listening: ${code}`)));
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const row = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (row.kind === 'listening') resolve(row);
      }
    });
  });
  const row = await listening;
  return { child, url: `http://127.0.0.1:${row.port}` };
}

test('fixture exposes readiness separately from successful HTTP responses', { timeout: 5000 }, async (t) => {
  const { url } = await fixture(t, { READY_DELAY_MS: '300', RELEASE: 'B' });
  assert.equal((await request(`${url}/health`)).status, 503);
  const before = await request(`${url}/version`);
  assert.equal(before.status, 200);
  assert.equal(before.body.ready, false);
  await sleep(350);
  assert.equal((await request(`${url}/health`)).status, 200);
  const never = await fixture(t, { NEVER_READY: 'true' });
  assert.equal((await request(`${never.url}/health`)).status, 503);
  assert.equal((await request(`${never.url}/version`)).body.readyAt, null);
});

test('fixture drains an in-flight delayed response on SIGTERM', { timeout: 5000 }, async (t) => {
  const { child, url } = await fixture(t, { RELEASE: 'A' });
  let started;
  const headers = new Promise((resolve) => { started = resolve; });
  const long = request(`${url}/slow?ms=250`, { onHeaders: started });
  assert.equal((await headers).release, 'A');
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const result = await long;
  assert.equal(result.body.release, 'A');
  assert.equal(result.error, undefined);
  assert.equal((await exited)[0], 0);
});

test('request deadlines are failures and are never retried', { timeout: 5000 }, async (t) => {
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; setTimeout(() => res.end('{}'), 200); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const result = await request(`http://127.0.0.1:${server.address().port}`, { timeout: 50 });
  assert.equal(result.error, 'request deadline exceeded');
  await sleep(250);
  assert.equal(requests, 1);
});
