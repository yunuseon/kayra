import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { request } from './http-probe.mjs';

test('the traffic client verifies TLS, distinguishes connections and records absolute body timeouts without retries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kayra-http-probe-')); t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'),
    '-days', '1', '-subj', '/CN=probe.lab.test', '-addext', 'subjectAltName=DNS:probe.lab.test'], { stdio: 'ignore' });
  const ca = await readFile(join(root, 'cert.pem'), 'utf8'); let connections = 0; let received = 0;
  const server = https.createServer({ key: await readFile(join(root, 'key.pem')), cert: ca }, (incoming, response) => {
    received += 1;
    response.writeHead(200, { 'content-type': 'application/json', 'x-probe-release': 'A', 'x-probe-task': 'task-a' });
    if (incoming.url === '/hang') { response.flushHeaders(); setTimeout(() => response.end('{}'), 200); }
    else response.end(incoming.url === '/bad' ? 'PRIVATE unexpected body' : JSON.stringify({ release: 'A', task: 'task-a', ready: true, readyAt: 1, requestStartedAt: Date.now() }));
  });
  server.on('secureConnection', () => { connections += 1; });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port; const target = { host: 'probe.lab.test', port, ca };
  assert.equal((await request(target)).release, 'A'); assert.equal((await request(target)).status, 200);
  assert.equal(connections, 2);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 }); t.after(() => agent.destroy());
  await request(target, { agent }); await request(target, { agent }); assert.equal(connections, 3);
  let headers;
  const timeout = await request(target, { path: '/hang', timeout: 25, onHeaders: (value) => { headers = value; } });
  assert.equal(timeout.error, 'timeout'); assert.equal(timeout.status, 200); assert.equal(headers.release, 'A');
  const bad = await request(target, { path: '/bad' }); assert.equal(bad.error, 'invalid-json'); assert.equal(JSON.stringify(bad).includes('PRIVATE'), false);
  const before = received; const untrusted = await request({ ...target, ca: undefined });
  assert.ok(untrusted.error); assert.equal(received, before); assert.equal(received, 6);
});
