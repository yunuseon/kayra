// Negative admission through the real builder and coordinator; no workload Create/Start or image pull.
import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { registryImages } from '../../../cli/src/server/runtime/registry-images.ts';

const [app, commit, request, output] = process.argv.slice(2); assert.equal(app, 'rollout-complete'); assert.match(commit, /^[a-f0-9]{40}$/); assert.match(request, /^[a-f0-9-]{36}$/); assert.ok(output);
await mkdir(output, { mode: 0o700 });
const run = promisify(execFile); const events = []; let size = 0; let failure; let observer; let observedExit; let complete = false;
const env = { ...process.env, COMPOSE_FILE: 'docker-compose.yml:docker-compose.ci.yml:docker-compose.swarm.yml:registration-lab.yml' };
const docker = async (...args) => (await run('docker', args, { env, cwd: '/opt/platform', timeout: 60000, maxBuffer: 1024 * 1024 })).stdout.trim();
const ctlArgs = (...args) => ['compose', 'exec', '-T', 'deployer', 'kayra-deployer', 'ctl', ...args];
const ctl = async (...args) => JSON.parse(await docker(...ctlArgs(...args)));
const containers = () => docker('ps', '-aq', '--no-trunc', '--filter', 'label=com.kayra.app=' + app);
try {
  const before = await ctl('lifecycle', 'status', app); const beforePins = await ctl('lifecycle', 'pins', app); const beforeContainers = await containers(); const beforeVolumes = await docker('volume', 'ls', '-q');
  observer = spawn('docker', ['events', '--filter', 'label=com.kayra.app=' + app, '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
  observedExit = once(observer, 'exit').catch(() => { failure = 'event observer failed'; }); observer.on('error', () => { failure = 'event observer failed'; }); let partial = '';
  observer.stdout.setEncoding('utf8'); observer.stdout.on('data', (chunk) => {
    size += Buffer.byteLength(chunk); if (size > 1024 * 1024) { failure = 'event evidence exceeded bound'; observer.kill('SIGTERM'); return; }
    partial += chunk; const lines = partial.split('\n'); partial = lines.pop();
    for (const line of lines) if (line) { try { events.push(JSON.parse(line)); } catch { failure = 'invalid event evidence'; } }
  });
  observer.stderr.on('data', () => { failure = 'event observer reported an error'; });
  observedExit.then(() => { if (!complete) failure = 'event observer ended prematurely'; });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const build = await ctl('build', app, commit); const retained = await ctl('pins');
  const artifact = retained.artifacts.find((value) => value.registration.app === app && value.commit === commit); assert.ok(artifact); assert.equal(artifact.images.length, 1);
  assert.equal(await registryImages('http://127.0.0.1:5000').verify(app, artifact.images), 'unsupported');
  const refusals = [];
  for (const args of [['preview', app, commit], ['lifecycle', 'prepare', app, commit, request], ['lifecycle', 'prepare', app, commit, request]]) {
    const refused = await run('docker', ctlArgs(...args), { env, cwd: '/opt/platform', timeout: 20000, maxBuffer: 16384 }).then(() => false, (error) => error.code === 1);
    assert.equal(refused, true, 'unsupported image unexpectedly admitted'); refusals.push({ command: args[0] === 'preview' ? 'preview' : 'prepare', refused });
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const after = await ctl('lifecycle', 'status', app); const afterPins = await ctl('lifecycle', 'pins', app);
  assert.deepEqual(after, before); assert.deepEqual(afterPins, beforePins); assert.equal(await containers(), beforeContainers); assert.equal(await docker('volume', 'ls', '-q'), beforeVolumes);
  assert.equal(failure, undefined); assert.equal(events.filter((value) => ['create', 'start', 'destroy'].includes(value.Action)).length, 0);
  const result = { passed: true, scope: 'real image with inherited VOLUME, registry-only metadata inspection, no accepted request or app workload/volume mutation', app, commit, request, build, artifact, refusals, before, after, pins: afterPins, workloadWrites: 0, anonymousVolumesCreated: 0 };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error), app, commit, request }, null, 2)); process.exitCode = 1; console.error(JSON.stringify({ error: String(error), output }));
} finally {
  if (observer && observer.exitCode === null) { complete = true; observer.kill('SIGTERM'); await observedExit; }
  await writeFile(join(output, 'docker-events.json'), JSON.stringify(events, null, 2));
}
