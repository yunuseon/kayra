import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseApplicationPlan } from '../../../cli/src/contracts/application-plan.ts';
import { dockerApi } from '../../../cli/src/server/runtime/docker-api.ts';
import { swarmService } from '../../../cli/src/server/runtime/swarm-service.ts';
const api = dockerApi(); const native = swarmService(api); const app = 'overlap-probe-' + randomUUID().slice(0, 8); const incarnation = randomUUID();
const host = JSON.parse(await readFile('/var/lib/kayra/swarm/authority.json', 'utf8'));
const template = JSON.parse(await readFile(new URL('../../../ci/tests/swarm-http/native-plan.json', import.meta.url), 'utf8'));
const sample = execFileSync('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=sample'], { encoding: 'utf8' }).trim();
const current = JSON.parse(execFileSync('docker', ['inspect', sample], { encoding: 'utf8' }))[0]; const tag = `localhost:5000/${app}/web:fixture`;
execFileSync('docker', ['tag', current.Image, tag]); execFileSync('docker', ['push', tag], { stdio: 'ignore' });
const image = JSON.parse(execFileSync('docker', ['image', 'inspect', tag], { encoding: 'utf8' }))[0].RepoDigests.find((value) => value.startsWith(`localhost:5000/${app}/web@`)); assert.ok(image);
const plan = (release) => { const parsed = parseApplicationPlan({ ...template, app, host, registration: { ...template.registration, app, incarnation, actionId: incarnation + ':1' },
  services: { web: { ...template.services.web, image, health: { ...template.services.web.health, command: ['true'] },
    command: ['sh', '-c', "trap 'sleep 20; exit 0' TERM; while :; do sleep 1; done"], environment: { RELEASE: { kind: 'literal', value: release }, TOKEN: { kind: 'secret', key: 'TOKEN' } } } },
  routes: [{ ...template.routes[0], host: app + '.lab.test' }] }); assert.ok(parsed.ok, parsed.error); return parsed.value; };
const a = plan('A'); const b = plan('B'); const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope = { app, service: 'web', incarnation }; const action = (value, id, effect = 'apply') => ({ ...scope, action: id, effect, plan: digest(value), deadline: Date.now() + 90000 });
const wait = async (condition) => { const until = Date.now() + 45000; while (Date.now() < until) { const value = await native.observe(scope); if (condition(value)) return value; await new Promise((resolve) => setTimeout(resolve, 100)); } throw Error('probe timed out'); };
let service; const snapshots = [];
try {
  assert.equal(await native.apply(action(a, incarnation + ':2'), null, a, { RELEASE: 'A', TOKEN: 'synthetic' }, {}), 'acknowledged');
  const initial = await wait((value) => value.status === 'owned' && value.tasks.some((task) => task.health === 'healthy')); service = initial.id;
  assert.equal(await native.apply(action(b, incarnation + ':3'), { id: service, version: initial.version }, b, { RELEASE: 'B', TOKEN: 'synthetic' }, {}), 'acknowledged');
  const overlapping = await wait((value) => value.status === 'owned' && value.tasks.some((task) => task.plan === digest(b) && task.health === 'healthy') && value.tasks.some((task) => task.plan === digest(a) && task.state === 'running' && task.desired === 'shutdown'));
  assert.equal(await native.apply(action(a, incarnation + ':3:restore:1', 'restore'), { id: service, version: overlapping.version }, a, { RELEASE: 'A', TOKEN: 'synthetic' }, {}), 'acknowledged');
  const until = Date.now() + 5000; let peak = 0;
  while (Date.now() < until) {
    const value = await native.observe(scope); const containers = execFileSync('docker', ['ps', '-q', '--filter', 'label=com.kayra.app=' + app], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    peak = Math.max(peak, containers.length); snapshots.push({ at: Date.now(), containers: containers.length, native: value });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const resultPath = process.argv[2] ?? '/tmp/kayra-recovery-overlap.json';
  const version = (await api.request('GET', '/version')).value;
  await writeFile(resultPath, JSON.stringify({ app, service, peakRunningContainers: peak, snapshots, image, engine: version.Version, api: version.ApiVersion }, null, 2));
  assert.equal(peak, 3, 'native recovery overlap changed; review HTTP admission');
  assert.equal((await api.request('DELETE', '/services/' + service)).status, 200);
  console.log(JSON.stringify({ app, peakRunningContainers: peak, result: resultPath, disposableServiceRemoved: true }));
} catch (error) { console.error(JSON.stringify({ app, service, error: String(error), cleanup: `docker service rm ${service ?? 'kayra-' + app + '--web'}` })); process.exitCode = 1; }
