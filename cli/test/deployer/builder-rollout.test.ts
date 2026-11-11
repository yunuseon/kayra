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

test("concurrent preparations keep each bundle at its requested commit", { skip: !yqAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kayra-builder-concurrent-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Kayra test"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    const commits = ["first", "second"].map((release) => {
      writeFileSync(join(repo, "app.yml"), "name: shop\ncompose: [compose.yml]\nroutes: []\n");
      writeFileSync(join(repo, "compose.yml"), release);
      execFileSync("git", ["-C", repo, "add", "."]);
      execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-qm", release]);
      const id = sha(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
      assert.ok(id.ok);
      return id.value;
    });
    const script = join(dir, "resolve-images.sh");
    writeFileSync(script, "#!/bin/sh\nsleep 0.2\n");
    const settings = { platformDir: dir, work: join(dir, "work"), deployer: "", resolveImages: script, webhookSecret: () => "", gitToken: () => "", healthToken: () => "", webhooks: false };
    const app = { ...shop, repo: `file://${repo}` };
    const results = await Promise.all(commits.map((id) => prepare(app, id, settings, () => undefined)));
    results.forEach((result, index) => {
      assert.ok(result.ok);
      assert.ok(typeof result.value === "object" && result.value !== null);
      assert.equal(Reflect.get(result.value, "sha"), commits[index]);
      const compose: unknown = Reflect.get(result.value, "compose");
      assert.ok(Array.isArray(compose));
      assert.equal(Reflect.get(compose[0], "content"), index === 0 ? "first" : "second");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("indexed builder carries validated rollout metadata while legacy preparation refuses it", { skip: !yqAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kayra-builder-rollout-artifact-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Kayra test"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    writeFileSync(join(repo, "compose.yml"), "services: {}\n");
    const marker = join(dir, "planned");
    const script = join(dir, "resolve-images.sh");
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`);
    const settings = { platformDir: dir, work: join(dir, "work"), deployer: "", resolveImages: script, webhookSecret: () => "", gitToken: () => "", healthToken: () => "", webhooks: false };
    const app = { ...shop, repo: `file://${repo}` };
    const incarnation = "11111111-1111-4111-8111-111111111111";
    const registration = { version: 1 as const, app: app.name, incarnation, actionId: incarnation + ":1", registrationGeneration: "22222222-2222-4222-8222-222222222222" };
    const rollout = { strategy: "rolling", mixed_version_compatible: true, rollback_compatible: true, services: { web: { role: "http", overlap: "allowed" } } };
    for (const [label, declaration, valid] of [["valid", rollout, true], ["false", false, false], ["null", null, false], ["private", { private: "SECRET-CONTENTS" }, false]] as const) {
      writeFileSync(join(repo, "app.yml"), JSON.stringify({ name: app.name, compose: ["compose.yml"], routes: [], rollout: declaration }));
      execFileSync("git", ["-C", repo, "add", "."]);
      execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-qm", label]);
      const id = sha(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
      assert.ok(id.ok);
      rmSync(marker, { force: true });
      const legacy = await prepare(app, id.value, settings, () => undefined);
      assert.equal(legacy.ok, false);
      assert.equal(existsSync(marker), false);
      const indexed = await prepare(app, id.value, settings, () => undefined, registration);
      assert.equal(indexed.ok, valid, label);
      assert.equal(existsSync(marker), valid, label);
      assert.equal(JSON.stringify(indexed).includes("SECRET-CONTENTS"), false);
      if (indexed.ok) {
        assert.ok(indexed.value !== null && typeof indexed.value === "object");
        assert.deepEqual(Reflect.get(indexed.value, "rollout"), { ...rollout, migrations: [], checks: [] });
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
