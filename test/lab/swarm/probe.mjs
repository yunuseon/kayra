import http from 'node:http';
import { performance } from 'node:perf_hooks';

export const isCurrentTask = (result, containers) => !result.error && result.status === 200 && result.body?.release === 'A'
  && result.body.ready === true && containers.some((id) => id.slice(0, 12) === result.body.task);

export function request(url, { agent = false, timeout = 2000, onHeaders = () => {} } = {}) {
  const at = Date.now();
  const start = performance.now();
  return new Promise((resolve) => {
    let finished = false;
    let status;
    let headers;
    const done = (fields) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      resolve({ at, endedAt: Date.now(), latencyMs: performance.now() - start, status, headers, ...fields });
    };
    const req = http.get(url, { agent, headers: { host: 'probe.swarm-lab.test' } }, (response) => {
      status = response.statusCode;
      headers = response.headers;
      onHeaders({ status, release: headers['x-probe-release'], task: headers['x-probe-task'] });
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('aborted', () => done({ error: 'response aborted' }));
      response.on('error', (error) => done({ error: error.code ?? error.message }));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { done({ body: JSON.parse(raw) }); }
        catch { done({ error: 'invalid JSON response', raw }); }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error('request deadline exceeded')), timeout);
    req.on('error', (error) => done({ error: error.code ?? error.message }));
  });
}

export function traffic(url, write) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 16 });
  const pending = new Set();
  let sequence = 0;
  const tick = () => {
    const connection = sequence++ % 2 === 0 ? 'fresh' : 'persistent';
    const promise = request(url, { agent: connection === 'fresh' ? false : agent })
      .then((result) => write({ kind: 'short', connection, ...result }))
      .finally(() => pending.delete(promise));
    pending.add(promise);
  };
  tick();
  const interval = setInterval(tick, 50);
  return async () => {
    clearInterval(interval);
    await Promise.all(pending);
    agent.destroy();
  };
}
