import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { isCurrentTask, request, traffic } from './probe.mjs';
import { assess, settlement, trafficEvidence, verdict } from './results.mjs';
import { analyze } from './analyze.mjs';
import { prepareMigrations, runMigrations, scenarios as migrationScenarios } from './migrations/runner.mjs';
import { analyzeMigrations, migrationVerdict } from './migrations/results.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..');
const quote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
const commandText = (argv) => argv.map(quote).join(' ');
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const line = (path, value) => appendFileSync(path, `${JSON.stringify(value)}\n`);
const progress = (message) => console.log(`── ${new Date().toISOString()} ${message}`);
const terminal = new Set(['completed', 'rollback_completed', 'paused', 'rollback_paused']);
const cancellation = new AbortController();
const sleep = (duration) => delay(duration, undefined, { signal: cancellation.signal });

if (process.argv[2] === '--observe') {
  const config = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  while (true) {
    let observation;
    try {
      const raw = execFileSync('ssh', [...config.ssh, commandText(['sudo', 'docker', 'service', 'inspect', 'probe'])], { encoding: 'utf8', timeout: 10000 });
      const service = JSON.parse(raw)[0];
      observation = {
        at: Date.now(), serviceId: service.ID, state: service.UpdateStatus?.State ?? 'pending',
        message: service.UpdateStatus?.Message,
        desiredRelease: service.Spec.TaskTemplate.ContainerSpec.Env.find((entry) => entry.startsWith('RELEASE='))?.slice(8),
      };
    } catch (error) {
      observation = { at: Date.now(), state: 'observation-error', error: error.message };
    }
    console.log(JSON.stringify(observation));
    if (terminal.has(observation.state)) break;
    if (Date.now() >= config.deadline) { console.log(JSON.stringify({ ...observation, at: Date.now(), state: 'deadline' })); break; }
    await sleep(1000);
  }
  process.exit(0);
}

function options(argv) {
  const value = { suite: 'http', keep: false, repeats: 3, modes: ['tasks', 'vip'], scenarios: ['healthy', 'slow-ready', 'never-ready', 'crash-after-ready', 'long-request', 'observer-interruption'] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--keep') value.keep = true;
    else if (['--output', '--repeats', '--mode', '--scenario', '--suite'].includes(arg)) {
      const next = argv[++index];
      if (!next) throw new Error(`${arg} requires a value`);
      if (arg === '--suite') value.suite = next;
      if (arg === '--output') value.output = resolve(next);
      if (arg === '--repeats') value.repeats = Number(next);
      if (arg === '--mode') value.modes = [next];
      if (arg === '--scenario') value.scenarios = [next];
    } else if (arg === '--help') {
      console.log('Usage: bash test/lab/swarm/run.sh [--suite http|migrations] [--keep] [--output DIR] [--repeats N] [--mode tasks|vip] [--scenario NAME]');
      process.exit(0);
    } else throw new Error(`unknown option ${arg}`);
  }
  if (!Number.isInteger(value.repeats) || value.repeats < 1 || value.repeats > 10) throw new Error('--repeats must be 1..10');
  if (value.modes.some((mode) => !['tasks', 'vip'].includes(mode))) throw new Error('unknown discovery mode');
  if (!['http', 'migrations'].includes(value.suite)) throw new Error('unknown suite');
  if (value.suite === 'migrations') {
    if (argv.includes('--mode') && value.modes[0] !== 'vip') throw new Error('migration suite requires VIP routing');
    value.modes = ['vip'];
    if (!argv.includes('--scenario')) value.scenarios = [...migrationScenarios];
  }
  const allowed = value.suite === 'migrations' ? migrationScenarios : ['healthy', 'slow-ready', 'never-ready', 'crash-after-ready', 'long-request', 'observer-interruption'];
  if (value.scenarios.some((scenario) => !allowed.includes(scenario))) throw new Error('unknown scenario');
  value.fullMatrix = value.repeats === 3 && (value.suite === 'migrations' ? value.scenarios.length === 8 : value.modes.length === 2 && value.scenarios.length === 6);
  return value;
}

const settings = options(process.argv.slice(2));
const summarize = settings.suite === 'migrations' ? migrationVerdict : verdict;
const analyzeOutput = settings.suite === 'migrations' ? analyzeMigrations : analyze;
const stamp = new Date().toISOString().replaceAll(/[-:.]/g, '').replace('Z', '').toLowerCase();
const output = settings.output ?? join(root, '.cache', settings.suite === 'migrations' ? 'swarm-migration-lab' : 'swarm-lab', stamp);
if (existsSync(output)) throw new Error(`output directory already exists: ${output}`);
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync('/tmp/kayra-swarm-');
const vm = `kayra-swarm-lab-${stamp}`;
const key = join(scratch, 'identity');
const control = join(scratch, 'ssh-%C');
const commands = join(output, 'commands.ndjson');
let vmCreated = false;
let ssh;
let target;
let passed = false;
let setupComplete = false;
let stopped = false;
let infrastructureError;
const collectors = [];
const activeCommands = new Set();
const activeObservers = new Set();
const results = [];
const metadata = { startedAt: new Date().toISOString(), sourceRoot: root, vm, output, scratch, settings, results };

async function run(program, args, { input, timeout = 120000, allowFailure = false, env, log = join(output, 'lab.log') } = {}) {
  line(commands, { at: Date.now(), program, args });
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(program, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    activeCommands.add(child);
    const chunks = [];
    const errors = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    const killer = setTimeout(() => child.kill('SIGKILL'), timeout + 3000);
    child.stdout.on('data', (chunk) => { chunks.push(chunk); appendFileSync(log, chunk); });
    child.stderr.on('data', (chunk) => { errors.push(chunk); appendFileSync(log, chunk); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', (error) => { clearTimeout(timer); clearTimeout(killer); rejectRun(error); });
    child.on('close', (code, signal) => {
      activeCommands.delete(child);
      clearTimeout(timer); clearTimeout(killer);
      const result = { code, signal, stdout: Buffer.concat(chunks).toString(), stderr: Buffer.concat(errors).toString() };
      if (code !== 0 && !allowFailure) rejectRun(new Error(`${program} exited ${code ?? signal}: ${result.stderr.slice(-1500) || result.stdout.slice(-1500)}`));
      else resolveRun(result);
    });
  });
}
const remote = (argv, options) => run('ssh', [...ssh, commandText(argv)], options);
const docker = (argv, options) => remote(['sudo', 'docker', ...argv], options);
const parseRemote = async (argv) => JSON.parse((await docker(argv)).stdout);

async function pull(image) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await docker(['pull', image], { timeout: 300000, allowFailure: true });
    if (result.code === 0) return;
    if (attempt === 3) throw new Error(`image download failed after three attempts: ${image}: ${result.stderr.slice(-1500)}`);
    progress(`image download attempt ${attempt} failed; retrying before measurement`);
    await sleep(attempt * 3000);
  }
}

function collect(argv, name) {
  const stdout = createWriteStream(join(output, name));
  const stderr = createWriteStream(join(output, `${name}.stderr`));
  const pid = `/home/ubuntu/swarm-lab/${name}.pid`;
  const script = `echo $$ > ${quote(pid)}\nexec ${commandText(argv)}`;
  const child = spawn('ssh', [...ssh, commandText(['setsid', 'sh', '-c', script])], { stdio: ['ignore', 'pipe', 'pipe'] });
  const collector = { child, name, pid };
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  child.on('error', (error) => stderr.write(`${error.message}\n`));
  collector.done = new Promise((resolveDone) => child.on('close', (code, signal) => {
    collector.exitedAt = Date.now();
    collector.code = code;
    collector.signal = signal;
    line(join(output, 'collectors.ndjson'), { at: collector.exitedAt, name, code, signal });
    resolveDone();
  }));
  collectors.push(collector);
}

function observer(config, path) {
  const configPath = `${path}.config.json`;
  json(configPath, config);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--observe', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  activeObservers.add(child);
  let buffer = '';
  let latest;
  let firstResolve;
  const first = new Promise((resolveFirst) => { firstResolve = resolveFirst; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const row = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!row) continue;
      latest = JSON.parse(row);
      line(path, latest);
      firstResolve(latest);
    }
  });
  child.stderr.on('data', (chunk) => appendFileSync(`${path}.stderr`, chunk));
  const done = new Promise((resolveDone) => {
    child.on('error', (error) => { firstResolve(null); resolveDone({ state: 'observer-error', error: error.message, at: Date.now() }); });
    child.on('close', () => { activeObservers.delete(child); firstResolve(latest); resolveDone(latest ?? { state: 'observer-error', at: Date.now() }); });
  });
  return { child, first, done };
}

async function waitForA() {
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    const result = await request(`${target}/version`);
    if (!result.error && result.status === 200 && result.body?.release === 'A' && result.body?.ready) {
      const ids = (await docker(['service', 'ps', '-q', '--filter', 'desired-state=running', 'probe'])).stdout.trim().split('\n').filter(Boolean);
      const tasks = ids.length ? await parseRemote(['inspect', '--type', 'task', ...ids]) : [];
      const containers = tasks.filter((task) => task.Status.State === 'running').map((task) => task.Status.ContainerStatus?.ContainerID).filter(Boolean);
      if (isCurrentTask(result, containers)) return { at: Date.now(), task: result.body.task, containers };
    }
    await sleep(1000);
  }
  throw new Error('release A did not become publicly available within 90 seconds');
}

async function snapshot(path) {
  const service = await docker(['service', 'inspect', 'probe'], { allowFailure: true });
  writeFileSync(join(path, 'service.json'), service.stdout);
  const tasks = await docker(['service', 'ps', '--no-trunc', '--format', '{{json .}}', 'probe'], { allowFailure: true });
  writeFileSync(join(path, 'tasks.ndjson'), tasks.stdout);
  const containers = await docker(['ps', '-aq', '--filter', 'label=com.docker.swarm.service.name=probe']);
  for (const id of containers.stdout.trim().split('\n').filter(Boolean)) {
    const inspection = await docker(['inspect', id], { allowFailure: true });
    writeFileSync(join(path, `container-${id}.json`), inspection.stdout);
    await docker(['logs', '--timestamps', id], { allowFailure: true, log: join(path, `container-${id}.log`) });
  }
}

async function createService(mode) {
  await docker(['service', 'rm', 'probe'], { allowFailure: true });
  await sleep(1500);
  await docker([
    'service', 'create', '--detach', '--name', 'probe', '--replicas', '1', '--no-resolve-image',
    '--network', 'lab-public', '--limit-memory', '128m', '--reserve-memory', '32m',
    '--update-order', 'start-first', '--update-monitor', '30s', '--update-failure-action', 'rollback',
    '--update-max-failure-ratio', '0', '--rollback-order', 'start-first', '--rollback-monitor', '5s',
    '--restart-delay', '1s', '--stop-grace-period', '30s',
    '--health-cmd', 'node /app/fixture.mjs health', '--health-interval', '1s', '--health-timeout', '1s',
    '--health-retries', '2', '--health-start-period', '20s',
    '--env', 'RELEASE=A', '--env', 'READY_DELAY_MS=0', '--env', 'NEVER_READY=false', '--env', 'FAIL_AFTER_READY_MS=0',
    '--label', 'traefik.enable=true', '--label', 'traefik.swarm.network=lab-public',
    '--label', `traefik.swarm.lbswarm=${mode === 'vip'}`,
    '--label', 'traefik.http.routers.probe.rule=Host(`probe.swarm-lab.test`)',
    '--label', 'traefik.http.routers.probe.entrypoints=web',
    '--label', 'traefik.http.routers.probe.service=probe',
    '--label', 'traefik.http.services.probe.loadbalancer.server.port=8080',
    metadata.images.fixture,
  ]);
  return await waitForA();
}

async function experiment(mode, scenario, repeat) {
  const name = `${mode}-${scenario}-${repeat}`;
  const path = join(output, name);
  mkdirSync(path);
  progress(name);
  const initial = await createService(mode);
  json(join(path, 'initial-task.json'), initial);
  const records = [];
  const write = (row) => { records.push(row); line(join(path, 'requests.ndjson'), row); };
  const stopTraffic = traffic(`${target}/version`, write);
  let longRequest;
  let longPromise;
  let observerResult;
  let monitor;
  let updateAt;
  let outcome;
  try {
    await sleep(5000);
    if (scenario === 'long-request') {
      let headersResolve;
      const headers = new Promise((resolveHeaders) => { headersResolve = resolveHeaders; });
      longPromise = request(`${target}/slow?ms=20000`, { timeout: 25000, onHeaders: headersResolve });
      const started = await Promise.race([headers, longPromise]);
      line(join(path, 'timeline.ndjson'), { kind: 'long-headers', at: Date.now(), ...started });
      if (started.release !== 'A') throw new Error('long request did not start on release A');
    }
    const serviceId = (await parseRemote(['service', 'inspect', 'probe']))[0].ID;
    updateAt = Date.now();
    line(join(path, 'timeline.ndjson'), { kind: 'update-submitted', at: updateAt, serviceId });
    const args = ['service', 'update', '--detach', '--env-add', 'RELEASE=B',
      '--env-add', `READY_DELAY_MS=${scenario === 'slow-ready' || scenario === 'observer-interruption' ? 15000 : 0}`,
      '--env-add', `NEVER_READY=${scenario === 'never-ready'}`,
      '--env-add', `FAIL_AFTER_READY_MS=${scenario === 'crash-after-ready' ? 5000 : 0}`, 'probe'];
    await docker(args);
    line(join(path, 'timeline.ndjson'), { kind: 'update-acknowledged', at: Date.now() });
    const config = { ssh, deadline: updateAt + 90000 };
    monitor = observer(config, join(path, 'observer-1.ndjson'));
    if (scenario === 'observer-interruption') {
      const first = await monitor.first;
      if (!first || terminal.has(first.state)) throw new Error('observer did not witness an in-progress update');
      const killedPid = monitor.child.pid;
      monitor.child.kill('SIGKILL');
      await monitor.done;
      line(join(path, 'timeline.ndjson'), { kind: 'observer-killed', at: Date.now(), pid: monitor.child.pid });
      await sleep(3000);
      monitor = observer(config, join(path, 'observer-2.ndjson'));
      const recovered = await monitor.first;
      observerResult = { killedPid, restartedPid: monitor.child.pid, reconstructed: recovered?.serviceId === serviceId && recovered?.desiredRelease === 'B', recovered };
    }
    const observed = await monitor.done;
    outcome = { ...observed, observedAt: observed.at };
    line(join(path, 'timeline.ndjson'), { kind: 'outcome', ...outcome });
    const expectedRelease = scenario === 'never-ready' || scenario === 'crash-after-ready' ? 'A' : 'B';
    while (!settlement(records, outcome, expectedRelease).stable && Date.now() < updateAt + 121000) await sleep(500);
    if (longPromise) { longRequest = await longPromise; write({ kind: 'long', ...longRequest }); }
  } finally {
    if (monitor && monitor.child.exitCode === null && monitor.child.signalCode === null) monitor.child.kill('SIGTERM');
    await stopTraffic();
    await snapshot(path);
  }
  const result = { mode, repeat, updateAt, finishedAt: Date.now(), ...assess({ scenario, records, outcome, updateAt, longRequest, observer: observerResult }) };
  results.push(result);
  json(join(path, 'result.json'), result);
  json(join(output, 'summary.json'), { ...metadata, verdict: summarize(results), finishedAt: null });
  progress(`${name}: ${result.passed ? 'PASS' : 'FAIL'} (${result.failedRequests}/${result.requests} failed; ${result.outcome.state})`);
  if (!result.traffic.passed) throw new Error('load-generator interruption or insufficient traffic invalidated the measurement');
}

const migrationContext = () => ({ metadata, docker, remote, run, pull, sleep, parseRemote, waitForA, snapshot, progress, results, settings, output, target });

async function main() {
  progress(`lab ${vm}; results ${output}`);
  metadata.commit = (await run('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  metadata.sourceStatus = (await run('git', ['-C', root, 'status', '--short'])).stdout;
  metadata.sourceHashes = Object.fromEntries(['lab.mjs', 'fixture.mjs', 'probe.mjs', 'results.mjs', 'telemetry.py'].map((name) => [name, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')]));
  metadata.hostDockerContextBefore = (await run('docker', ['context', 'show'])).stdout.trim();
  metadata.multipassBefore = JSON.parse((await run('multipass', ['list', '--format', 'json'])).stdout);
  await run('ansible-playbook', ['--version']);
  const compose = readFileSync(join(root, 'compose/docker-compose.yml'), 'utf8');
  const pin = (name) => {
    const value = compose.match(new RegExp(`image: (${name}[^\\s]+)`))?.[1];
    if (!value?.includes('@sha256:')) throw new Error(`missing digest pin for ${name}`);
    return value;
  };
  const nodeImage = readFileSync(join(root, 'compose/deployer/Dockerfile.deployer'), 'utf8').match(/^FROM (node:\S+)/m)?.[1];
  if (!nodeImage?.includes('@sha256:')) throw new Error('missing pinned Node image');
  metadata.images = { traefik: pin('traefik:'), socketProxy: pin('tecnativa/docker-socket-proxy:'), node: nodeImage, fixture: `kayra-swarm-probe:${stamp}` };
  json(join(output, 'metadata.json'), metadata);
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  progress('launching isolated Multipass VM');
  await run('multipass', ['launch', '24.04', '--name', vm, '--cpus', '2', '--memory', '4G', '--disk', '20G'], { timeout: 600000 });
  vmCreated = true;
  await run('multipass', ['exec', vm, '--', 'cloud-init', 'status', '--wait'], { timeout: 300000, allowFailure: true });
  const info = JSON.parse((await run('multipass', ['info', vm, '--format', 'json'])).stdout);
  const ip = info.info[vm].ipv4.find((value) => !value.startsWith('172.'));
  if (!ip) throw new Error('lab VM has no host-reachable IPv4 address');
  metadata.ip = ip;
  target = `http://${ip}`;
  const publicKey = readFileSync(`${key}.pub`, 'utf8').trim();
  await run('multipass', ['exec', vm, '--', 'bash', '-s'], { input: `set -euo pipefail\nmkdir -p /home/ubuntu/.ssh\nprintf '%s\\n' ${quote(publicKey)} >> /home/ubuntu/.ssh/authorized_keys\nchmod 700 /home/ubuntu/.ssh\nchmod 600 /home/ubuntu/.ssh/authorized_keys\n` });
  ssh = ['-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${join(scratch, 'known_hosts')}`, '-o', 'ControlMaster=auto', '-o', 'ControlPersist=60s', '-o', `ControlPath=${control}`, `ubuntu@${ip}`];
  const inventory = join(scratch, 'inventory.json');
  const play = join(scratch, 'docker.yml');
  json(inventory, { all: { hosts: { lab: { ansible_host: ip, ansible_user: 'ubuntu', ansible_ssh_private_key_file: key } } } });
  writeFileSync(play, `---\n- name: Prepare isolated Swarm lab\n  hosts: all\n  become: true\n  pre_tasks:\n    - name: Install Docker role prerequisites\n      ansible.builtin.apt:\n        name: [python3-debian, apparmor]\n        state: present\n        update_cache: true\n    - name: Create the Docker role deploy user\n      ansible.builtin.user:\n        name: deploy\n        create_home: true\n  roles:\n    - docker\n`);
  progress('provisioning with Kayra Docker role');
  await run('ansible-playbook', ['-i', inventory, play], { timeout: 900000, env: {
    ANSIBLE_CONFIG: join(root, 'ansible/ansible.cfg'), ANSIBLE_ROLES_PATH: join(root, 'ansible/roles'), ANSIBLE_STDOUT_CALLBACK: 'default', PYTHONDONTWRITEBYTECODE: '1',
  } });
  await remote(['mkdir', '-p', '/home/ubuntu/swarm-lab']);
  for (const name of ['fixture.mjs', 'telemetry.py']) {
    await run('multipass', ['transfer', join(directory, name), `${vm}:/home/ubuntu/swarm-lab/${name}`]);
  }
  await remote(['tee', '/home/ubuntu/swarm-lab/Dockerfile'], { input: `FROM ${nodeImage}\nWORKDIR /app\nCOPY fixture.mjs .\nUSER node\nCMD ["node", "/app/fixture.mjs"]\n` });
  await pull(metadata.images.traefik);
  await pull(metadata.images.socketProxy);
  await pull(nodeImage);
  await docker(['build', '-t', metadata.images.fixture, '/home/ubuntu/swarm-lab'], { timeout: 600000 });
  await docker(['swarm', 'init', '--advertise-addr', ip]);
  await docker(['swarm', 'update', '--task-history-limit', '20']);
  await docker(['network', 'create', '--driver', 'overlay', '--attachable', 'lab-public']);
  await docker(['network', 'create', '--internal', 'lab-socket']);
  await docker(['run', '-d', '--name', 'socket-proxy', '--network', 'lab-socket', '--memory', '64m',
    '-v', '/var/run/docker.sock:/var/run/docker.sock:ro',
    ...['CONTAINERS=1', 'EVENTS=1', 'VERSION=1', 'PING=1', 'SERVICES=1', 'NETWORKS=1', 'TASKS=1', 'NODES=1', 'POST=0'].flatMap((value) => ['-e', value]), metadata.images.socketProxy]);
  await docker(['run', '-d', '--name', 'traefik', '--network', 'lab-public', '--memory', '256m', '-p', '80:80', metadata.images.traefik,
    '--entrypoints.web.address=:80', '--providers.docker.endpoint=tcp://socket-proxy:2375', '--providers.docker.exposedbydefault=false',
    '--providers.swarm.endpoint=tcp://socket-proxy:2375', '--providers.swarm.exposedbydefault=false', '--providers.swarm.network=lab-public',
    '--accesslog=true', '--accesslog.format=json', '--log.level=INFO']);
  await docker(['network', 'connect', 'lab-socket', 'traefik']);
  metadata.versions = {
    docker: JSON.parse((await docker(['version', '--format', '{{json .}}'])).stdout),
    compose: (await docker(['compose', 'version'])).stdout.trim(),
    os: (await remote(['cat', '/etc/os-release'])).stdout,
    kernel: (await remote(['uname', '-a'])).stdout.trim(),
    node: process.version,
    multipass: (await run('multipass', ['version'])).stdout.trim(),
  };
  metadata.imageInspections = await parseRemote(['image', 'inspect', metadata.images.traefik, metadata.images.socketProxy, metadata.images.fixture]);
  const checks = await docker(['run', '--rm', '--network', 'lab-socket', '--entrypoint', 'node', metadata.images.fixture, '-e',
    "const base='http://socket-proxy:2375'; const get=await fetch(base+'/version'); const post=await fetch(base+'/containers/create',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});console.log(JSON.stringify({get:get.status,post:post.status}));if(!get.ok||post.status!==403)process.exit(1)"]);
  metadata.socketProxyChecks = JSON.parse(checks.stdout);
  if (settings.suite === 'migrations') await prepareMigrations(migrationContext());
  json(join(output, 'metadata.json'), metadata);
  collect(['sudo', 'docker', 'events', '--format', '{{json .}}'], 'docker-events.ndjson');
  collect(['sudo', 'python3', '-u', '/home/ubuntu/swarm-lab/telemetry.py'], 'metrics.ndjson');
  collect(['sudo', 'docker', 'logs', '--follow', '--timestamps', 'traefik'], 'traefik.log');
  collect(['sudo', 'docker', 'logs', '--follow', '--timestamps', 'socket-proxy'], 'socket-proxy.log');
  setupComplete = true;
  if (settings.suite === 'migrations') {
    await runMigrations(migrationContext());
    passed = results.every((result) => result.passed);
    return;
  }
  for (const mode of settings.modes) {
    progress(`${mode}: 30-second baseline`);
    await createService(mode);
    const baseline = [];
    const stop = traffic(`${target}/version`, (row) => { baseline.push(row); line(join(output, `baseline-${mode}.ndjson`), row); });
    try { await sleep(31000); }
    finally { await stop(); }
    if (!trafficEvidence(baseline).passed) throw new Error(`${mode} baseline load-generator interruption invalidated the measurement`);
    if (baseline.some((row) => row.error || row.status !== 200 || !row.body?.ready)) throw new Error(`${mode} baseline is unhealthy; scenario measurements would be invalid`);
    for (let repeat = 1; repeat <= settings.repeats; repeat++) {
      for (const scenario of settings.scenarios) await experiment(mode, scenario, repeat);
    }
  }
  passed = results.every((result) => result.passed);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopped) return;
  stopped = true;
  infrastructureError = `interrupted by ${signal}`;
  progress(`interrupted; preserving ${vm}`);
  cancellation.abort();
  for (const child of activeCommands) child.kill('SIGTERM');
  for (const child of activeObservers) child.kill('SIGTERM');
  json(join(output, 'interrupted.json'), { at: Date.now(), signal, vm, output });
});

try {
  await main();
} catch (error) {
  infrastructureError = error.stack ?? error.message;
  appendFileSync(join(output, 'lab.log'), `${infrastructureError}\n`);
  progress(`infrastructure failure: ${error.message}`);
} finally {
  const collectorStopAt = Date.now();
  if (ssh) {
    for (const { pid } of collectors) {
      const script = `if [ -f ${quote(pid)} ]; then\n  kill -TERM -- -$(cat ${quote(pid)})\nfi`;
      await remote(['sudo', 'bash', '-c', script], { allowFailure: true }).catch(() => {});
    }
  }
  for (const { child } of collectors) child.kill('SIGTERM');
  await Promise.race([Promise.all(collectors.map((collector) => collector.done)), delay(5000)]);
  if (ssh && setupComplete) {
    for (const name of ['traefik', 'socket-proxy']) {
      if (!collectors.some((collector) => collector.name === `${name}.log`)) {
        await docker(['logs', '--timestamps', name], { allowFailure: true, log: join(output, `${name}.log`) }).catch(() => {});
      }
      await docker(['inspect', name], { allowFailure: true, log: join(output, `${name}-inspect.json`) }).catch(() => {});
    }
    await docker(['info'], { allowFailure: true, log: join(output, 'docker-info.txt') }).catch(() => {});
  }
  metadata.hostDockerContextAfter = (await run('docker', ['context', 'show'], { allowFailure: true })).stdout.trim();
  metadata.multipassAfter = JSON.parse((await run('multipass', ['list', '--format', 'json'], { allowFailure: true })).stdout || '{}');
  if (metadata.hostDockerContextBefore !== metadata.hostDockerContextAfter) infrastructureError ??= 'host Docker context changed unexpectedly';
  const metricsPath = join(output, 'metrics.ndjson');
  const metrics = existsSync(metricsPath) ? readFileSync(metricsPath, 'utf8').split('\n').filter(Boolean).flatMap((row) => { try { return [JSON.parse(row)]; } catch { return []; } }).filter((row) => row.kind === 'vm') : [];
  const resources = {
    samples: metrics.length,
    peakMemoryUsedMiB: metrics.length ? Math.max(...metrics.map((row) => (row.memoryTotalBytes - row.memoryAvailableBytes) / 1048576)) : null,
    minimumMemoryAvailableMiB: metrics.length ? Math.min(...metrics.map((row) => row.memoryAvailableBytes / 1048576)) : null,
    peakCpuBusyFraction: metrics.length ? Math.max(...metrics.map((row) => row.cpuBusyFraction ?? 0)) : null,
  };
  const collection = collectors.map(({ name, exitedAt, code, signal }) => ({ name, exitedAt, code, signal, unexpectedExit: exitedAt < collectorStopAt }));
  if (setupComplete && (!resources.samples || collection.some((collector) => collector.unexpectedExit))) infrastructureError ??= 'telemetry collection failed; results need investigation';
  if (setupComplete && (!metrics.at(-1) || collectorStopAt - metrics.at(-1).at > 30000)) infrastructureError ??= 'telemetry does not cover the end of the run';
  const summary = { ...metadata, verdict: summarize(results), resources, collection, infrastructureError, finishedAt: new Date().toISOString() };
  json(join(output, 'summary.json'), summary);
  try {
    const analyzed = analyzeOutput(output);
    passed = passed && analyzed.results.every((row) => row.passed);
  } catch (error) {
    infrastructureError ??= `evidence analysis failed: ${error.message}`;
    json(join(output, 'summary.json'), { ...summary, infrastructureError });
    writeFileSync(join(output, 'report.md'), `# Swarm rollout experiment\n\nINCOMPLETE: ${infrastructureError}\n`);
  }
  if (vmCreated && passed && !infrastructureError && !settings.keep) {
    progress(`destroying successful lab ${vm}`);
    await run('multipass', ['delete', '--purge', vm]);
    rmSync(scratch, { recursive: true, force: true });
  } else if (vmCreated) {
    progress(`kept for inspection: ${vm}`);
    console.log(`Cleanup: multipass delete --purge ${quote(vm)}`);
    console.log(`Lab-only SSH key: ${key}`);
  }
  progress(`report: ${join(output, 'report.md')}`);
}
process.exitCode = stopped ? 130 : infrastructureError || !passed ? 1 : 0;
