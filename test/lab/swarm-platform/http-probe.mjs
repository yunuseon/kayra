import https from 'node:https';
import { performance } from 'node:perf_hooks';

export function request({ address = '127.0.0.1', port = 443, host, ca }, { path = '/version', agent = false, timeout = 2000, onHeaders = () => {} } = {}) {
  const at = Date.now(); const started = performance.now();
  return new Promise((resolve) => {
    let finished = false; let status;
    const done = (fields) => {
      if (finished) return;
      finished = true; clearTimeout(deadline);
      resolve({ at, endedAt: Date.now(), latencyMs: performance.now() - started, status, ...fields });
    };
    const req = https.get({ hostname: address, port, servername: host, ca, rejectUnauthorized: true, path, agent,
      headers: { Host: host },
    }, (response) => {
      status = response.statusCode;
      onHeaders({ at: Date.now(), status, release: response.headers['x-probe-release'], task: response.headers['x-probe-task'] });
      const chunks = []; let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 65536) { done({ error: 'oversized-response' }); req.destroy(); }
        else chunks.push(chunk);
      });
      response.on('aborted', () => done({ error: 'response-aborted' }));
      response.on('error', (error) => done({ error: error.code ?? 'response-error' }));
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (typeof body.release !== 'string' || typeof body.task !== 'string' || typeof body.ready !== 'boolean') return done({ error: 'invalid-identity' });
          done({ release: body.release, task: body.task, ready: body.ready, readyAt: body.readyAt, requestStartedAt: body.requestStartedAt });
        } catch { done({ error: 'invalid-json' }); }
      });
    });
    const deadline = setTimeout(() => { done({ error: 'timeout' }); req.destroy(); }, timeout);
    req.on('error', (error) => done({ error: error.code ?? 'connection-error' }));
  });
}

export function traffic(target, write) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 16 });
  const pending = new Set(); let sequence = 0; let lastStart; let scheduleBase = performance.now(); let timer; let stopped = false;
  const tick = () => {
    if (stopped) return;
    const now = performance.now(); const gapMs = lastStart === undefined ? null : now - lastStart; lastStart = now;
    if (gapMs !== null && gapMs > 2000) scheduleBase = now - sequence * 50;
    const connection = sequence++ % 2 === 0 ? 'fresh' : 'persistent';
    const result = request(target, { agent: connection === 'fresh' ? false : agent })
      .then((value) => write({ kind: 'short', connection, gapMs, ...value })).finally(() => pending.delete(result));
    pending.add(result);
    timer = setTimeout(tick, Math.max(0, scheduleBase + sequence * 50 - performance.now()));
  };
  tick();
  return async () => { stopped = true; clearTimeout(timer); await Promise.all(pending); agent.destroy(); };
}
