// Application-owned behavior for the lab. Kayra never imports this into its coordinator.
function stateServer() {
  const http = require('node:http'); const effects = {}; const calls = {};
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture'); const operation = request.headers['x-operation'];
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/health') return response.end('{"ready":true}');
    if (url.pathname === '/snapshot') return response.end(JSON.stringify({ effects, calls }));
    if (typeof operation !== 'string') { response.statusCode = 400; return response.end('{}'); }
    if (url.pathname === '/apply' && request.method === 'POST') {
      calls[operation] = (calls[operation] ?? 0) + 1;
      if (url.searchParams.get('safe') !== '1' || effects[operation] === undefined) effects[operation] = (effects[operation] ?? 0) + 1;
      return response.end(JSON.stringify({ calls: calls[operation], effects: effects[operation] }));
    }
    if (url.pathname === '/probe') {
      const outcome = url.searchParams.get('mode') === 'unknown' ? 'unknown' : effects[operation] > 0 ? 'applied' : 'not-applied';
      return response.end(JSON.stringify({ version: 1, outcome }));
    }
    response.statusCode = 404; response.end('{}');
  });
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); }); server.listen(8080, '0.0.0.0');
}
function applyMigration() {
  if (process.env.FAIL_BEFORE === '1') return process.exit(1);
  fetch('http://' + process.env.DB_HOST + ':8080/apply?safe=' + process.env.REPLAY_SAFE, {
    method: 'POST', headers: { 'x-operation': process.env.KAYRA_OPERATION_ID },
  }).then((response) => response.json()).then(async (value) => {
    const hold = Number(process.env.MIGRATION_HOLD_MS ?? '0'); if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
    process.exit(process.env.FAIL_ALWAYS === '1' || process.env.FAIL_FIRST === '1' && value.calls === 1 ? 1 : 0);
  }).catch(() => process.exit(1));
}
function probeMigration() {
  fetch('http://' + process.env.DB_HOST + ':8080/probe?mode=' + process.env.PROBE_MODE, { headers: { 'x-operation': process.env.KAYRA_OPERATION_ID } })
    .then((response) => response.json()).then((value) => { process.stdout.write(JSON.stringify(value) + '\n'); }).catch(() => process.exit(1));
}
export const serverCode = `(${stateServer.toString()})()`;
export const migrationCommand = ['--input-type=commonjs', '-e', `(${applyMigration.toString()})()`];
export const probeCommand = ['--input-type=commonjs', '-e', `(${probeMigration.toString()})()`];

// Keep the readiness probe inexpensive under the fixture's quarter-CPU limit.
export const healthCommand = ['node', '--input-type=commonjs', '-e', "const r=require('node:http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',{timeout:800},s=>{s.resume();process.exit(s.statusCode>=200&&s.statusCode<300?0:1)});r.on('timeout',()=>{r.destroy();process.exit(1)});r.on('error',()=>process.exit(1))"];
