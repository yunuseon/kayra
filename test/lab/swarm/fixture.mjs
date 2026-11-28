import http from 'node:http';
import os from 'node:os';

if (process.argv[2] === 'health') {
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/health`, { signal: AbortSignal.timeout(800) });
    process.exit(response.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}

const startedAt = Date.now();
const readyAt = startedAt + Number(process.env.READY_DELAY_MS ?? 0);
const neverReady = process.env.NEVER_READY === 'true';
const release = process.env.RELEASE ?? 'A';
const task = os.hostname();
let draining = false;
const failAfter = Number(process.env.FAIL_AFTER_READY_MS ?? 0);
let failureScheduled = false;
const event = (kind, fields = {}) => console.log(JSON.stringify({ at: Date.now(), kind, release, task, ...fields }));
const ready = () => !neverReady && Date.now() >= readyAt && !draining;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture');
  const requestStartedAt = Date.now();
  const body = { release, task, startedAt, readyAt: neverReady ? null : readyAt, requestStartedAt, ready: ready() };
  const health = url.pathname === '/health';
  if (health && body.ready && failAfter > 0 && !failureScheduled) {
    failureScheduled = true;
    event('health-failure-armed', { failAfter });
    setTimeout(() => { event('crash'); process.exit(42); }, failAfter);
  }
  const status = health && !body.ready ? 503 : 200;
  if (draining) response.shouldKeepAlive = false;
  response.once('finish', () => { if (draining) setImmediate(() => server.closeIdleConnections()); });
  response.writeHead(status, { 'content-type': 'application/json', 'x-probe-release': release, 'x-probe-task': task, ...(draining ? { connection: 'close' } : {}) });
  if (url.pathname === '/slow') {
    response.flushHeaders();
    event('slow-start', { requestStartedAt });
    setTimeout(() => {
      response.end(JSON.stringify(body));
      event('slow-end', { requestStartedAt });
    }, Math.min(Number(url.searchParams.get('ms') ?? 20000), 25000));
  } else {
    response.end(JSON.stringify(body));
  }
  if (!health) event('request', { path: url.pathname, requestStartedAt, ready: body.ready });
});

server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => event('listening', { port: server.address().port, readyAt: neverReady ? null : readyAt }));
if (!neverReady) {
  setTimeout(() => event('ready'), Math.max(0, readyAt - Date.now()));
}
process.on('SIGTERM', () => {
  draining = true;
  event('terminating');
  server.close(() => { event('closed'); process.exit(0); });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 29000).unref();
});
