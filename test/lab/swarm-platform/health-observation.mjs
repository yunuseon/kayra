// The deployment owner publishes runtime health; the platform consumes that read port.
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const [app, output, ...options] = process.argv.slice(2); assert.equal(app, 'rollout-complete'); assert.ok(output); assert.ok(options.every((value) => value === '--require-failed-history'));
const run = promisify(execFile); const env = { ...process.env, COMPOSE_FILE: 'docker-compose.yml:docker-compose.ci.yml:docker-compose.swarm.yml:registration-lab.yml' };
const docker = async (...args) => (await run('docker', args, { env, cwd: '/opt/platform', timeout: 30000, maxBuffer: 1024 * 1024 })).stdout.trim();
const ctl = async (...args) => JSON.parse(await docker('compose', 'exec', '-T', 'deployer', 'kayra-deployer', 'ctl', ...args));
const before = await ctl('lifecycle', 'status', app); const containers = await docker('ps', '-aq', '--no-trunc', '--filter', 'label=com.kayra.app=' + app); const startedAt = Date.now();
const report = await ctl('lifecycle', 'health', app); assert.equal(report.state, 'available'); assert.equal(report.scope, 'runtime-services'); assert.ok(report.observedAt >= startedAt); assert.ok(report.observedAt > before.verifiedActive.verifiedAt);
assert.equal(report.services.length, 1); assert.equal(report.services[0].healthyTasks, 1); assert.ok(report.services[0].ignoredHistoricalTasks >= 1);
const rawTasks = (await docker('service', 'ps', '--no-trunc', '--format', '{{.ID}}|{{.DesiredState}}|{{.CurrentState}}', 'kayra-' + app + '--web')).split('\n');
const historical = [];
for (const row of rawTasks) {
  const [id, desired] = row.split('|'); if (desired !== 'Shutdown') continue;
  const task = JSON.parse(await docker('inspect', id, '--format', '{{json .Status}}'));
  const container = task.ContainerStatus?.ContainerID;
  const health = container === undefined ? undefined : await docker('inspect', container, '--format', '{{json .State.Health}}').then((value) => JSON.parse(value), () => undefined);
  historical.push({ task: id, desired, state: task.State, container, health: health?.Status ?? 'unavailable', probeTimeouts: health?.Log?.filter((entry) => entry.ExitCode === -1).length ?? 0 });
}
const failedHistoricalTasks = historical.filter((value) => value.state === 'failed' || value.probeTimeouts > 0);
if (options.includes('--require-failed-history')) assert.ok(failedHistoricalTasks.length >= 1);
const deployers = (await docker('ps', '-q', '--filter', 'label=com.docker.compose.project=platform', '--filter', 'label=com.docker.compose.service=deployer', '--filter', 'label=com.docker.compose.oneoff=False')).split('\n'); assert.equal(deployers.length, 1);
const platform = JSON.parse(await docker('exec', deployers[0], 'node', '--input-type=module', '--eval', 'const response=await fetch("http://127.0.0.1:8090/health",{signal:AbortSignal.timeout(15000)});console.log(JSON.stringify({status:response.status,body:await response.json()}))'));
assert.equal(platform.status, 200); assert.equal(platform.body.healthy, true); assert.deepEqual(await ctl('lifecycle', 'status', app), before); assert.equal(await docker('ps', '-aq', '--no-trunc', '--filter', 'label=com.kayra.app=' + app), containers);
const result = { passed: true, scope: 'fresh owned runtime observations, historical task filtering and existing platform health endpoint; not routed readiness or SQL/worker acceptance', app, before, runtime: report, rawTasks, historical, failedHistoricalTasks: failedHistoricalTasks.length, platform, releasePromotionFromHealth: false, docker: JSON.parse(await docker('version', '--format', '{{json .}}')), node: process.version };
await writeFile(output, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
