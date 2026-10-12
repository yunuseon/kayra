import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseServer, type ServerFiles } from "../src/fleet.ts";
import { files, server } from "./support.ts";

const refused = (descriptor: string, overrides: Partial<ServerFiles> = {}) => {
  const parsed = parseServer(files("shop-test", descriptor, overrides));
  return parsed.ok ? "accepted" : parsed.error;
};

test("a server's kind defaults to platform", () => {
  strictEqual(server("shop", "target: multipass\ndomain: shop.test\n").kind, "platform");
});

test("a server is refused for what would break a command later", () => {
  strictEqual(refused("kind: castle\ntarget: home\ndomain: a.test"), "kind must be platform, edge, nas, not 'castle'");
  strictEqual(refused("target: moon\ndomain: a.test"), "target must be multipass, hetzner, home, not 'moon'");
  strictEqual(refused("target: home"), "domain is required");
  strictEqual(refused("- a list"), "is not a YAML mapping");
  strictEqual(
    refused("kind: edge\ntarget: hetzner\ndomain: a.test\nvault: true\napps: [{name: shop, repo: https://x.test/s.git}]"),
    "apps run on platform servers only",
  );
  strictEqual(
    refused("target: home\ndomain: a.test\nvault: true", { inventory: undefined }),
    "target home needs a hand-written inventory.ini next to it",
  );
  strictEqual(refused("target: hetzner\ndomain: a.test\nvault: true", { terraform: false }), "no terraform/ next to it");
  strictEqual(refused("target: multipass\ndomain: a.test", { secrets: undefined }), "no secrets.yml next to it");
  strictEqual(
    refused("target: multipass\ndomain: a.test", { vars: "$ANSIBLE_VAULT;1.1;AES256\n" }),
    "vars.yml is vault-encrypted; it holds settings only — secrets go in secrets.yml",
  );
  strictEqual(refused("target: hetzner\ndomain: a.test"), "target hetzner requires vault: true");
  strictEqual(
    refused("target: home\ndomain: a.test\nvault: true", { secrets: "admin: admin\n" }),
    "target home requires a vault-encrypted secrets.yml",
  );
  strictEqual(refused("target: multipass\ndomain: a.test", { secrets: "admin: admin\n" }), "accepted");
});

test("an app's config is plaintext, its secrets vaulted wherever secrets.yml is", () => {
  const vault = "$ANSIBLE_VAULT;1.1;AES256\n";
  const prod = (file: string, text: string) =>
    refused("target: hetzner\ndomain: a.test\nvault: true", { appValues: [{ file, text }] });
  strictEqual(prod("shop.yml", "FLAG: on\n"), "accepted");
  strictEqual(prod("shop.secrets.yml", vault), "accepted");
  strictEqual(
    prod("shop.yml", vault),
    "apps/shop.yml is vault-encrypted; it holds config only — secrets go in apps/shop.secrets.yml",
  );
  strictEqual(prod("shop.secrets.yml", "PASSWORD: hunter2\n"), "apps/shop.secrets.yml must be vault-encrypted");
  strictEqual(
    refused("target: multipass\ndomain: a.test", {
      secrets: "admin: admin\n",
      appValues: [{ file: "shop.secrets.yml", text: "PASSWORD: test\n" }],
    }),
    "accepted",
  );
});

test("an app lives in its own repo, cloned over HTTPS, its root inside it", () => {
  const app = (entry: string) => refused(`target: multipass\ndomain: a.test\napps: [${entry}]`);
  strictEqual(app("{name: shop, repo: git@x.test:s.git}"), "app shop: repo must be an https:// URL");
  strictEqual(app("{name: shop, path: shop}"), "app shop: repo must be an https:// URL");
  strictEqual(app("{name: shop, repo: https://x.test/s.git, path: ../up}"), "app shop: path must stay inside its repo");
  deepStrictEqual(server("a", "target: multipass\ndomain: a.test\napps: [{name: shop, repo: https://x.test/s.git, ref: main}]").apps, [
    { name: "shop", repo: "https://x.test/s.git", entry: '{"name":"shop","repo":"https://x.test/s.git","ref":"main"}' },
  ]);
});

test("the vault: none, asked for, or a password file under ~", () => {
  deepStrictEqual(server("a", "target: multipass\ndomain: a.test\nvault: false").vault, { kind: "none" });
  deepStrictEqual(server("a", "target: hetzner\ndomain: a.test\nvault: true").vault, { kind: "ask" });
  deepStrictEqual(
    server("a", "target: hetzner\ndomain: a.test\nvault: true\nvault_password_file: ~/.vault_pass").vault,
    { kind: "file", file: join(homedir(), ".vault_pass") },
  );
  strictEqual(
    refused("target: hetzner\ndomain: a.test\nvault: true\nvault_password_file: vault_pass"),
    "'vault_pass' is not an absolute path",
  );
});

test("only a home server builds a VM image, and only when vars.yml has a vm", () => {
  const home = "target: home\ndomain: a.test\nvault: true";
  strictEqual(server("a", home, { vars: "vm:\n  address: 10.0.0.2\n" }).vm, true);
  strictEqual(server("a", home).vm, false);
  strictEqual(server("a", "target: hetzner\ndomain: a.test\nvault: true", { vars: "vm: {}\n" }).vm, false);
});

test("the hosts a server's stacks route, relative to its domain where they are under it", () => {
  deepStrictEqual(
    server("a", "target: home\ndomain: a.test\nvault: true", {
      stacks: ["rule=Host(`git.a.test`) || Host(`ci.a.test`)", "rule=Host(`other.example`)"],
    }).stackHosts,
    ["git", "ci", "other.example"],
  );
});

test("DNS-01 is a server whose vars.yml names a provider", () => {
  const home = "target: home\ndomain: a.test\nvault: true";
  strictEqual(server("a", home, { vars: "acme_dns: hetzner\n" }).acmeDns, true);
  strictEqual(server("a", home, { vars: "acme_dns: ''\n" }).acmeDns, false);
  strictEqual(server("a", home).acmeDns, false);
});
