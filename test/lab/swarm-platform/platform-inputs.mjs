// Isolated permission and generation checks with synthetic inputs, never application secrets.
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, chown, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { platformServiceInputs } from '../../../cli/src/server/platform/service-inputs.ts';

const [mode, output] = process.argv.slice(2); assert.ok(output);
const root = join(output, 'input-fixtures');
if (mode === '--reader') {
  assert.equal(process.getuid(), 1000); assert.equal(process.getgid(), 1000);
  const refs = JSON.parse(await readFile(join(root, 'references.json'), 'utf8'));
  const port = platformServiceInputs(join(root, 'public'), join(root, 'private'), 1000);
  const baseline = await port.materialize(refs.baseline); assert.ok(baseline.ok);
  assert.equal(baseline.value.DB_PASSWORD, 'synthetic-password'); assert.equal(baseline.value.DB_NAME, 'database');
  const cases = {};
  for (const [name, expected] of [['unrelatedInputs', 'unchanged'], ['usedSecret', 'changed'], ['usedConfiguration', 'changed'], ['missingSecret', 'unavailable'], ['wrongMode', 'unavailable'], ['wrongManifest', 'unavailable'], ['wrongConfigurationIdentity', 'unavailable']]) {
    cases[name] = await port.compare(refs.baseline, refs[name]); assert.equal(cases[name], expected, name);
  }
  assert.equal(JSON.stringify(cases).includes('synthetic'), false);
  console.log(JSON.stringify({ passed: true, readerUid: process.getuid(), readerGid: process.getgid(), cases }));
} else {
  assert.equal(mode, '--prepare'); assert.equal(process.getuid(), 0);
  await mkdir(root, { mode: 0o755 }); await mkdir(join(root, 'public'), { mode: 0o755 }); await mkdir(join(root, 'private'), { mode: 0o750 }); await chown(join(root, 'private'), 0, 1000);
  const incarnation = randomUUID(); const app = 'input-lab'; const key = createHash('sha256').update(app).digest('hex');
  const refs = {};
  const file = async (path, content, permissions, group) => { await writeFile(path, content, { mode: permissions }); await chown(path, 0, group); await chmod(path, permissions); };
  const directories = async (path, permissions, group) => { await mkdir(path, { recursive: true, mode: permissions }); await chown(path, 0, group); await chmod(path, permissions); };
  for (const name of ['baseline', 'unrelatedInputs', 'usedSecret', 'usedConfiguration', 'missingSecret', 'wrongMode', 'wrongManifest', 'wrongConfigurationIdentity']) {
    const metadata = { version: 1, app, incarnation, actionId: `${incarnation}:1`, registrationGeneration: randomUUID() };
    const pub = join(root, 'public', key, 'generations', metadata.registrationGeneration); const priv = join(root, 'private', key, 'generations', metadata.registrationGeneration);
    await directories(pub, 0o755, 0); await directories(priv, 0o750, 1000); await directories(join(priv, 'secrets'), 0o750, 1000);
    // Recursive mkdir intermediates must be readable by the deployer's group, not writable.
    for (const path of [join(root, 'private', key), join(root, 'private', key, 'generations')]) await directories(path, 0o750, 1000);
    const configuration = JSON.stringify({ DATABASE: name === 'usedConfiguration' ? 'other-database' : 'database', THEME: name === 'baseline' ? 'dark' : 'light' });
    const manifest = name === 'wrongManifest' ? { ...metadata, registrationGeneration: randomUUID() } : metadata;
    await file(join(pub, 'manifest.json'), JSON.stringify(manifest), 0o444, 0);
    await file(join(pub, 'registration.json'), JSON.stringify({ name: app, runtime: 'swarm', repo: 'https://example.invalid/input-lab.git', path: '.', ref: 'main', hosts: [], secrets: ['PASSWORD', 'UNUSED_TOKEN'], grants: { memory_bytes: 268435456, cpu_millicores: 500, maintenance: false } }), 0o444, 0);
    await file(join(priv, 'manifest.json'), JSON.stringify(metadata), 0o440, 1000);
    await file(join(priv, 'configuration.json'), configuration, 0o440, 1000);
    if (name !== 'missingSecret') await file(join(priv, 'secrets', 'PASSWORD'), name === 'usedSecret' ? 'synthetic-rotation' : 'synthetic-password', name === 'wrongMode' ? 0o600 : 0o440, 1000);
    await file(join(priv, 'secrets', 'UNUSED_TOKEN'), name === 'baseline' ? 'synthetic-unused-old' : 'synthetic-unused-new', 0o440, 1000);
    refs[name] = { version: 1, registration: metadata, configurationIdentity: name === 'wrongConfigurationIdentity' ? 'sha256:' + '0'.repeat(64) : 'sha256:' + createHash('sha256').update(configuration).digest('hex'), environment: { DB_PASSWORD: { kind: 'secret', key: 'PASSWORD' }, DB_NAME: { kind: 'configuration', key: 'DATABASE' } } };
  }
  await file(join(root, 'references.json'), JSON.stringify(refs), 0o444, 0);
  const result = JSON.parse(execFileSync(process.execPath, [new URL(import.meta.url).pathname, '--reader', output], { uid: 1000, gid: 1000, encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  assert.equal(result.passed, true); await writeFile(join(output, 'platform-inputs.json'), JSON.stringify({ ...result, scope: 'isolated immutable registration readers and retained-input comparison; no retained service reconciliation or coordinator integration', node: process.version }, null, 2));
  await rm(root, { recursive: true }); console.log(JSON.stringify(result));
}
