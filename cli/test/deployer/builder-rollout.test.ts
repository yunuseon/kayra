import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepare } from '../../src/server/builder/builder.ts';
import { sha } from '../../src/deployer/brand.ts';
import { shop } from './support.ts';

const yqAvailable = spawnSync('yq', ['--version']).status === 0;

test('builder refuses any rollout declaration before building images without logging its contents', { skip: !yqAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kayra-builder-test-'));
  try {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Kayra test']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    writeFileSync(join(repo, 'compose.yml'), 'services: {}\n');
    const marker = join(dir, 'image-planned');
    const script = join(dir, 'resolve-images.sh');
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
    const settings = { platformDir: dir, work: join(dir, 'work'), deployer: '', resolveImages: script, webhookSecret: () => '', gitToken: () => '', healthToken: () => '', webhooks: false };
    const app = { ...shop, repo: `file://${repo}` };
    const variants = [
      ['absent', '', true],
      ['false', 'rollout: false\n', false],
      ['null', 'rollout: null\n', false],
      ['zero', 'rollout: 0\n', false],
      ['empty', "rollout: ''\n", false],
      ['mapping', 'rollout:\n  private: SECRET-CONTENTS\n', false],
      ['invalid', 'rollout: [SECRET-CONTENTS\n', false],
    ] as const;
    for (const [label, content, allowed] of variants) {
      writeFileSync(join(repo, 'app.yml'), `name: shop\ncompose: [compose.yml]\n${content}`);
      execFileSync('git', ['-C', repo, 'add', '.']);
      execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', label]);
      const commit = sha(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
      assert.equal(commit.ok, true);
      rmSync(marker, { force: true });
      // eslint-disable-next-line functional/prefer-immutable-types -- record the process output to test it for disclosure
      const lines: string[] = [];
      const result = await prepare(app, commit.value, settings, (line) => {
        // eslint-disable-next-line functional/immutable-data -- collect this invocation's output
        lines.push(line);
      });
      assert.equal(result.ok, allowed, label);
      assert.equal(existsSync(marker), allowed, label);
      assert.equal(JSON.stringify({ result, lines }).includes('SECRET-CONTENTS'), false, label);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
