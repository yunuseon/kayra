import { deepStrictEqual, match, ok as assert, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { absolutePath, appName, kayraRoot, kayraVersion } from "../src/core/fleet/brand.ts";
import { render } from "../src/core/plan/describe.ts";
import { launch } from "../src/core/recipes/launch.ts";
import { must, root, server } from "./support.ts";

const engine = { kayra: kayraRoot(must(absolutePath("/kayra"))), fleet: root, version: must(kayraVersion("0.19.0")) };
const shop = must(appName("shop"));
const lab = server("lab", "kind: platform\ntarget: multipass\ndomain: lab.test\napps: [{name: blog, repo: https://example.com/blog.git}]\n");
const wanted = { app: shop, repo: "https://example.com/shop.git", ref: undefined, path: undefined, dir: undefined };

test("launch: prepare, then kayra apps with the new entry, then the deploy, followed", () => {
  const lines = render(must(launch(engine, root, lab, wanted)));
  match(lines[0] ?? "", /kayra-app-launch\.js .*"entry":\{"name":"shop","repo":"https:\/\/example\.com\/shop\.git"\}/);
  assert(lines.some((line) => line.includes('"name":"shop"') && line.includes("app.yml")), "the app playbook runs for the new entry");
  assert(lines.some((line) => line.includes('"keep": ["blog","shop"]') || line.includes('{"keep": ["blog","shop"]}')), "the prune keeps it");
  match(lines.at(-1) ?? "", /kayra-deployer ctl deploy shop/);
});

test("launch: an app not yet registered needs its repository; a registered one takes no other", () => {
  deepStrictEqual(launch(engine, root, lab, { ...wanted, repo: undefined }), { ok: false, error: "shop is not in lab's server.yml yet: give its repository with --repo https://…" });
  const blog = must(appName("blog"));
  strictEqual(launch(engine, root, lab, { ...wanted, app: blog, repo: undefined }).ok, true);
  strictEqual(launch(engine, root, lab, { ...wanted, app: blog, repo: "https://example.com/blog.git", ref: "main", path: "." }).ok, true);
  deepStrictEqual(launch(engine, root, lab, { ...wanted, app: blog }), { ok: false, error: "lab's server.yml registers blog with another repo: change it there, not through launch" });
});

test("launch: only on a platform server", () => {
  const edge = server("edge", "kind: edge\ntarget: multipass\ndomain: example.com\n");
  deepStrictEqual(launch(engine, root, edge, wanted), { ok: false, error: "'edge' is a edge server: only platform servers run apps." });
});

const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "kayra-launch-"));
  const serverDir = join(directory, "servers", "lab");
  const repo = join(directory, "shop");
  mkdirSync(join(serverDir, "apps"), { recursive: true });
  mkdirSync(join(serverDir, "terraform"));
  mkdirSync(repo);
  writeFileSync(join(directory, "servers/defaults.yml"), "{}\n");
  writeFileSync(join(serverDir, "server.yml"), "# the lab\nkind: platform\ntarget: multipass\ndomain: lab.test\napps:\n  - {name: blog, repo: https://example.com/blog.git} # kept\n");
  writeFileSync(join(serverDir, "vars.yml"), "{}\n");
  writeFileSync(join(serverDir, "secrets.yml"), "{}\n");
  writeFileSync(join(repo, "app.yml"), "name: shop\ncompose: [compose.yml]\nconfig: [MODE]\nsecrets: [PASSWORD]\n");
  return { directory, serverDir, repo, clean: () => { rmSync(directory, { recursive: true, force: true }); } };
};

const helper = resolve(import.meta.dirname, "../../bin/kayra-app-launch.js");
const prepare = (f: Readonly<{ directory: string; repo: string }>) =>
  spawnSync(process.execPath, [helper, JSON.stringify({ root: f.directory, server: "lab", entry: { name: "shop", repo: "https://example.com/shop.git" }, dir: f.repo })], { encoding: "utf8" });

test("prepare: registers the app once, keeping server.yml's comments, and names every missing value with its command", (t) => {
  const f = fixture(); t.after(f.clean);
  const first = prepare(f);
  strictEqual(first.status, 1);
  match(first.stderr, /✓ registered shop in .*server\.yml/);
  match(first.stderr, /shop needs 2 value\(s\)/);
  match(first.stderr, /kayra app config set lab shop MODE VALUE/);
  match(first.stderr, /kayra app secret generate lab shop PASSWORD/);
  const written = readFileSync(join(f.serverDir, "server.yml"), "utf8");
  match(written, /# the lab/);
  match(written, /# kept/);
  match(written, /name: shop/);
  writeFileSync(join(f.serverDir, "apps", "shop.yml"), "MODE: live\n");
  writeFileSync(join(f.serverDir, "apps", "shop.secrets.yml"), "PASSWORD: fixture\n");
  const again = prepare(f);
  strictEqual(again.status, 0, again.stderr);
  match(again.stdout, /✓ shop is registered in lab's server\.yml/);
  match(again.stdout, /✓ every value shop declares is set \(1 config, 1 secret\)/);
  strictEqual(readFileSync(join(f.serverDir, "server.yml"), "utf8"), written, "a second launch registers nothing twice");
  assert(!again.stdout.includes("fixture"), "values are never printed");
});
