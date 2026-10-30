import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { yamlOf } from "../../src/lib/yaml.ts";

const ansibleAvailable = spawnSync("ansible-playbook", ["--version"]).status === 0;
const root = resolve(import.meta.dirname, "../../..");

test("registration records the fleet's Compose selection, including the default", { skip: !ansibleAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), "kayra-registration-runtime-"));
  try {
    const parsed = yamlOf(readFileSync(join(root, "ansible/roles/app/tasks/main.yml"), "utf8"));
    assert.ok(parsed.ok);
    assert.ok(Array.isArray(parsed.value));
    const task: unknown = parsed.value.find((entry: unknown) => typeof entry === "object" && entry !== null && Reflect.get(entry, "name") === "Register the app");
    assert.ok(typeof task === "object" && task !== null);
    const copy: unknown = Reflect.get(task, "ansible.builtin.copy");
    assert.ok(typeof copy === "object" && copy !== null);
    // Run the real registration task unprivileged in a temporary directory.
    const copyForTest = Object.fromEntries(Object.entries(copy).filter(([key]) => key !== "owner" && key !== "group"));
    const platform = join(dir, "platform");
    mkdirSync(join(platform, "apps"), { recursive: true });
    for (const runtime of [undefined, "compose"] as const) {
      const app = { name: "shop", ...(runtime === undefined ? {} : { runtime }) };
      const vars = { app, app_repo: "https://example.test/shop.git", app_ref: "main", app_subdomains: ["www"], manifest: {}, platform_dir: platform, domain: "lab.test" };
      const play = join(dir, "play.json");
      writeFileSync(play, JSON.stringify([{ hosts: "localhost", connection: "local", gather_facts: false, vars, tasks: [{ ...task, "ansible.builtin.copy": copyForTest, become: false }] }]));
      const result = spawnSync("ansible-playbook", ["-i", "localhost,", play], { encoding: "utf8", env: { ...process.env, ANSIBLE_NOCOLOR: "1" } });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const registration: unknown = JSON.parse(readFileSync(join(platform, "apps/shop.json"), "utf8"));
      assert.ok(typeof registration === "object" && registration !== null);
      assert.equal(Reflect.get(registration, "runtime"), "compose");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registration refuses rollout metadata or an unsupported runtime before writing app data", { skip: !ansibleAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), "kayra-registration-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Kayra test"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    const fleet = join(dir, "fleet");
    const server = join(fleet, "servers", "lab");
    const platform = join(dir, "platform");
    mkdirSync(server, { recursive: true });
    for (const [index, manifest, runtime, existing] of [
      [0, "name: shop\nrollout: null\n", undefined, undefined],
      [1, "name: shop\n", "swarm", undefined],
      [2, "name: shop\n", undefined, '{"name":"shop","runtime":"swarm"}'],
    ] as const) {
      writeFileSync(join(repo, "app.yml"), manifest);
      execFileSync("git", ["-C", repo, "add", "."]);
      execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", `case-${String(index)}`]);
      if (existing !== undefined) {
        mkdirSync(join(platform, "apps"), { recursive: true });
        writeFileSync(join(platform, "apps", "shop.json"), existing);
      }
      const app = { name: "shop", repo: `file://${repo}`, ref: "main", ...(runtime === undefined ? {} : { runtime }) };
      const vars = { app, fleet_root: fleet, server_dir: server, server: "lab", kayra_root: root, apps_dir: join(dir, "apps"), platform_dir: platform, domain: "lab.test", git_token: "test", app_secrets: {} };
      const play = join(dir, "play.json");
      writeFileSync(play, JSON.stringify([{ hosts: "localhost", connection: "local", gather_facts: false, vars, roles: ["app"] }]));
      const result = spawnSync("ansible-playbook", ["-i", "localhost,", play], {
        encoding: "utf8",
        env: { ...process.env, ANSIBLE_ROLES_PATH: join(root, "ansible", "roles"), ANSIBLE_NOCOLOR: "1" },
      });
      assert.notEqual(result.status, 0);
      const message = existing !== undefined ? /existing registration does not use a supported Compose runtime/
        : runtime === undefined ? /rollout metadata is not yet supported/ : /only the Compose runtime is currently supported/;
      assert.match(result.stdout + result.stderr, message);
      assert.equal(existsSync(platform), existing !== undefined);
      if (existing !== undefined) assert.equal(readFileSync(join(platform, "apps", "shop.json"), "utf8"), existing);
      assert.equal(existsSync(join(dir, "apps")), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
