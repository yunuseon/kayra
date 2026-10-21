import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { absolutePath, appName, fleetRoot, kayraRoot, kayraVersion } from "../src/core/fleet/brand.ts";
import { loadFleet } from "../src/core/fleet/load.ts";
import { valuesReportSchema } from "../src/core/app-values/model.ts";
import { inspectValues, editValues } from "../src/core/app-values/store.ts";
import { appValues } from "../src/core/recipes/app-values.ts";
import { textAt } from "../src/core/adapters/fs.ts";
import { must, sealed, testKey } from "./support.ts";

const app = must(appName("demo"));
const engine = kayraRoot(must(absolutePath(resolve(import.meta.dirname, "../.."))));
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "kayra-values-"));
  const root = fleetRoot(must(absolutePath(directory)));
  const serverDir = join(directory, "servers", "lab");
  const repo = must(absolutePath(join(directory, "project")));
  mkdirSync(join(serverDir, "apps"), { recursive: true });
  mkdirSync(join(serverDir, "terraform"));
  mkdirSync(repo);
  writeFileSync(join(directory, "servers/defaults.yml"), "{}\n");
  writeFileSync(join(serverDir, "server.yml"), "target: multipass\ndomain: lab.test\napps: [{name: demo, repo: https://example.com/demo.git}]\n");
  writeFileSync(join(serverDir, "vars.yml"), "{}\n");
  writeFileSync(join(serverDir, "secrets.yml"), "{}\n");
  writeFileSync(join(repo, "app.yml"), "name: demo\ncompose: [compose.yml]\nconfig: [FLAG, COUNT]\nsecrets: [PASSWORD, TOKEN]\n");
  const server = must(loadFleet(root)).servers[0];
  if (server === undefined) throw new Error("missing fixture server");
  return { root, server, repo, config: join(serverDir, "apps/demo.yml"), secret: join(serverDir, "secrets.yml"),
    clean: () => { rmSync(directory, { recursive: true, force: true }); } };
};

test("requirements report distinguishes false and zero from missing values without returning contents", async (t) => {
  const f = fixture(); t.after(f.clean);
  writeFileSync(f.config, "FLAG: false\nCOUNT: 0\n");
  writeFileSync(f.secret, "app_secrets:\n  demo:\n    PASSWORD: fixture-private-password\n");
  const report = must(await inspectValues(f.root, f.server, app, f.repo));
  deepStrictEqual(report.config, [{ key: "FLAG", state: "set" }, { key: "COUNT", state: "set" }]);
  deepStrictEqual(report.secrets, [{ key: "PASSWORD", state: "set" }, { key: "TOKEN", state: "missing" }]);
  strictEqual(JSON.stringify(report).includes("fixture-private-password"), false);
  strictEqual(report.manifest, join(f.repo, "app.yml"));
});

test("configuration preserves unrelated keys and comments, and rejects secret keys", async (t) => {
  const f = fixture(); t.after(f.clean);
  writeFileSync(f.config, "# environment\nCOUNT: 3 # keep\n");
  must(await editValues(f.root, f.server, app, { kind: "config", key: "FLAG", value: "on" }, f.repo));
  const saved = readFileSync(f.config, "utf8");
  match(saved, /# environment/); match(saved, /COUNT: 3 # keep/); match(saved, /FLAG: on/);
  strictEqual((await editValues(f.root, f.server, app, { kind: "config", key: "PASSWORD", value: "no" }, f.repo)).ok, false);
  strictEqual(readFileSync(f.config, "utf8"), saved);
});

test("secret generation preserves existing values and file bytes on retry", async (t) => {
  const f = fixture(); t.after(f.clean);
  must(await editValues(f.root, f.server, app, { kind: "generate", key: "PASSWORD" }, f.repo));
  const before = readFileSync(f.secret, "utf8");
  match(before, /PASSWORD: [a-f0-9]{64}/);
  must(await editValues(f.root, f.server, app, { kind: "generate", key: "PASSWORD" }, f.repo));
  strictEqual(readFileSync(f.secret, "utf8"), before);
  strictEqual(statSync(f.secret).mode & 0o777, 0o600);
});

test("imports treat contents as data, preserve other secrets, and never return the value", async (t) => {
  const f = fixture(); t.after(f.clean);
  writeFileSync(f.secret, "git_token: keep-me-too\napp_secrets:\n  demo:\n    PASSWORD: keep-me\n");
  const file = join(f.root, "credential");
  const value = "token: with # YAML and $(shell) `characters`\nsecond line";
  writeFileSync(file, `${value}\n`);
  const result = must(await editValues(f.root, f.server, app, { kind: "import", key: "TOKEN", file }, f.repo));
  strictEqual(result.includes(value), false);
  match(readFileSync(f.secret, "utf8"), /PASSWORD: keep-me/);
  match(readFileSync(f.secret, "utf8"), /git_token: keep-me-too/);
  const report = must(await inspectValues(f.root, f.server, app, f.repo));
  strictEqual(report.secrets.every((each) => each.state === "set"), true);
  strictEqual(readFileSync(file, "utf8"), `${value}\n`);
});

test("malformed YAML is refused without exposing it or changing the file", async (t) => {
  const f = fixture(); t.after(f.clean);
  const source = "PASSWORD: [fixture-private-malformed\n";
  writeFileSync(f.secret, source);
  const result = await editValues(f.root, f.server, app, { kind: "generate", key: "PASSWORD" }, f.repo);
  strictEqual(result.ok, false);
  strictEqual(JSON.stringify(result).includes("fixture-private-malformed"), false);
  strictEqual(readFileSync(f.secret, "utf8"), source);
});

test("missing and mismatched manifests, overlapping names, and symlinked destinations are refused", async (t) => {
  const f = fixture(); t.after(f.clean);
  strictEqual((await inspectValues(f.root, f.server, app)).ok, false);
  writeFileSync(join(f.repo, "app.yml"), "name: other\ncompose: []\nconfig: [FLAG]\n");
  strictEqual((await inspectValues(f.root, f.server, app, f.repo)).ok, false);
  writeFileSync(join(f.repo, "app.yml"), "name: demo\ncompose: []\nconfig: [FLAG]\nsecrets: [FLAG]\n");
  strictEqual((await inspectValues(f.root, f.server, app, f.repo)).ok, false);
  writeFileSync(join(f.repo, "app.yml"), "name: demo\ncompose: []\nconfig: [FLAG]\n");
  const other = join(f.root, "unrelated");
  writeFileSync(other, "unchanged\n");
  symlinkSync(other, f.config);
  strictEqual((await editValues(f.root, f.server, app, { kind: "config", key: "FLAG", value: "on" }, f.repo)).ok, false);
  strictEqual(readFileSync(other, "utf8"), "unchanged\n");
});

test("local plans contain a source path, never secret contents, and need no deployment main guard", (t) => {
  const f = fixture(); t.after(f.clean);
  const file = join(f.root, "credential");
  writeFileSync(file, "fixture-private-value\n");
  const plan = must(appValues({ kayra: engine, fleet: f.root, version: must(kayraVersion("0.19.0")) }, f.server, app,
    { kind: "import", key: "TOKEN", file }, f.root, textAt, f.repo));
  strictEqual(JSON.stringify(plan).includes(file), true);
  strictEqual(JSON.stringify(plan).includes("fixture-private-value"), false);
  strictEqual(plan.some((step) => step.kind === "check"), false);
  strictEqual(readFileSync(file, "utf8"), "fixture-private-value\n");
});

test("the packaged helper updates a real fixture fleet and returns no imported secret", (t) => {
  const f = fixture(); t.after(f.clean);
  const file = join(f.root, "credential");
  writeFileSync(file, "fixture-helper-secret\n");
  const request = { root: f.root, server: "lab", app, dir: f.repo, edit: { kind: "import", key: "TOKEN", file } };
  const result = spawnSync(process.execPath, [join(engine, "bin/kayra-app-values.js"), JSON.stringify(request)], { encoding: "utf8" });
  strictEqual(result.status, 0, result.stderr);
  strictEqual((result.stdout + result.stderr).includes("fixture-helper-secret"), false);
  strictEqual(must(inspectFixture(f)).secrets[1]?.state, "set");
});

const inspectFixture = (f: Readonly<{ root: string; repo: string }>) => {
  const result = spawnSync(process.execPath, [join(engine, "bin/kayra.js"), "app", "values", "lab", "demo", "--dir", f.repo, "--json"], { cwd: f.root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return { ok: true, value: valuesReportSchema.parse(JSON.parse(result.stdout)) } as const;
};

test("real SOPS: set in place, kept on retry, read without the key, and a wrong key changes nothing", async (t) => {
  const f = fixture(); t.after(f.clean);
  sealed(f.secret, "git_token: keep-me\n");
  const withKey = (key: string) => {
    writeFileSync(join(f.server.dir, "server.yml"), `target: multipass\ndomain: lab.test\nage_key_file: ${key}\napps: [{name: demo, repo: https://example.com/demo.git}]\n`);
    const server = must(loadFleet(f.root)).servers[0];
    if (server === undefined) throw new Error("missing fixture server");
    return server;
  };
  const server = withKey(testKey);
  strictEqual(server.secrets.encrypted, true);
  const before = readFileSync(f.secret, "utf8");
  must(await editValues(f.root, server, app, { kind: "generate", key: "PASSWORD" }, f.repo));
  const ciphertext = readFileSync(f.secret, "utf8");
  strictEqual(ciphertext.split("\n")[0], before.split("\n")[0]);
  match(ciphertext, /^ {8}PASSWORD: ENC\[AES256_GCM,/m);
  const plaintext = execFileSync("sops", ["decrypt", f.secret], { encoding: "utf8", env: { ...process.env, SOPS_AGE_KEY_FILE: testKey } });
  match(plaintext, /PASSWORD: [a-f0-9]{64}/);
  must(await editValues(f.root, server, app, { kind: "generate", key: "PASSWORD" }, f.repo));
  strictEqual(readFileSync(f.secret, "utf8"), ciphertext);
  const other = join(f.root, "other-key.txt");
  execFileSync("age-keygen", ["-o", other], { stdio: "pipe" });
  const locked = withKey(other);
  deepStrictEqual(must(await inspectValues(f.root, locked, app, f.repo)).secrets, [{ key: "PASSWORD", state: "set" }, { key: "TOKEN", state: "missing" }]);
  strictEqual((await editValues(f.root, locked, app, { kind: "generate", key: "TOKEN" }, f.repo)).ok, false);
  strictEqual(readFileSync(f.secret, "utf8"), ciphertext);
  deepStrictEqual(readdirSync(join(f.server.dir, "apps")), []);
});
