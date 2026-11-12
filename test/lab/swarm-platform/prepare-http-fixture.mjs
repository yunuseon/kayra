import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';

const run = promisify(execFile);
const [destination, served, repo, output] = process.argv.slice(2);
assert.ok(destination && served && repo && output, 'usage: prepare-http-fixture.mjs <new-source-directory> <new-bare-repo-directory> <http-repo-url> <manifest.json>');
const gitUrl = new URL(repo);
assert.ok(gitUrl.protocol === 'http:' && !gitUrl.username && !gitUrl.password && /^(?:192\.168\.|10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(gitUrl.hostname) && /^\/lab\/[a-z0-9-]+\.git$/.test(gitUrl.pathname), 'fixture must use the private lab Git server');
const source = resolve(destination); const bare = resolve(served); const manifest = resolve(output);
// mkdir without recursive deliberately refuses accidental reuse of another repository.
await mkdir(source); await cp(new URL('./http-fixture/', import.meta.url), source, { recursive: true });
const git = (...args) => run('git', ['-C', source, ...args]);
await git('init', '-q', '-b', 'main');
const cases = {
  A: { release: 'A' },
  healthy: { release: 'B-healthy' },
  'slow-ready': { release: 'B-slow', delay: 15000 },
  'never-ready': { release: 'B-never', never: true },
  'crash-after-ready': { release: 'B-crash', crash: 8000 },
  'long-request': { release: 'B-long' },
  'observer-interruption': { release: 'B-interrupted' },
};
const base = YAML.parse(await readFile(join(source, 'deploy/compose.yml'), 'utf8'));
const commits = {};
for (const [name, settings] of Object.entries(cases)) {
  const compose = structuredClone(base);
  Object.assign(compose.services.web.environment, { RELEASE: settings.release, READY_DELAY_MS: String(settings.delay ?? 0),
    NEVER_READY: String(settings.never ?? false), FAIL_AFTER_READY_MS: String(settings.crash ?? 0) });
  await writeFile(join(source, 'deploy/compose.yml'), YAML.stringify(compose));
  await git('add', '-A');
  await git('-c', 'user.name=Kayra lab', '-c', 'user.email=lab@kayra.test', '-c', 'commit.gpgsign=false', 'commit', '-s', '-qm', 'HTTP fixture: ' + name);
  commits[name] = (await git('rev-parse', 'HEAD')).stdout.trim();
}
await mkdir(dirname(bare), { recursive: true }); await run('git', ['clone', '-q', '--bare', source, bare]);
const matrix = Object.keys(cases).filter((name) => name !== 'A').flatMap((name) => Array.from({ length: 3 }, (_, index) => ({
  name, repeat: index + 1, commit: commits[name], release: cases[name].release,
  resetRequest: randomUUID(), updateRequest: randomUUID(),
})));
await mkdir(dirname(manifest), { recursive: true });
await writeFile(manifest, JSON.stringify({ version: 1, app: 'rollout-http', host: 'rollout.lab.test', repo,
  commits, matrix, initialRequest: randomUUID(), source, bare, createdAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ manifest, app: 'rollout-http', commits, cases: matrix.length }));
