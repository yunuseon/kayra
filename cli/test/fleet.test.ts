import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseServer } from "../src/core/fleet/parse.ts";
import type { ServerFiles } from "../src/core/fleet/model.ts";
import { files, server } from "./support.ts";

/** What SOPS writes: each value encrypted, its metadata under sops. */
const sealed = "PASSWORD: ENC[AES256_GCM,data:AA==,iv:AA==,tag:AA==,type:str]\nsops:\n    age:\n        - recipient: age1test\n";

const refused = (descriptor: string, overrides: Partial<ServerFiles> = {}) => {
  const parsed = parseServer(files("shop-test", descriptor, overrides));
  return parsed.ok ? "accepted" : parsed.error;
};

test("a server's kind defaults to platform", () => {
  strictEqual(server("shop", "target: multipass\ndomain: shop.test\n").kind, "platform");
});

test("the fleet can select Compose and rejects unsupported runtimes", () => {
  const app = (runtime: string) => `target: multipass\ndomain: a.test\napps: [{name: shop, repo: https://x.test/s.git, runtime: ${runtime}}]`;
  strictEqual(server("a", app("compose")).apps[0]?.entry["runtime"], "compose");
  strictEqual(refused(app("swarm")) === "accepted", false);
  strictEqual(refused(app("unknown")) === "accepted", false);
});

test("a server is refused for what would break a command later", () => {
  strictEqual(refused("kind: castle\ntarget: home\ndomain: a.test"), "kind must be platform, edge, nas, not 'castle'");
  strictEqual(refused("target: moon\ndomain: a.test"), "target must be multipass, hetzner, home, not 'moon'");
  strictEqual(refused("target: home"), "domain is required");
  strictEqual(refused("- a list"), "is not a YAML mapping");
  strictEqual(
    refused("kind: edge\ntarget: hetzner\ndomain: a.test\napps: [{name: shop, repo: https://x.test/s.git}]"),
    "apps run on platform servers only",
  );
  strictEqual(
    refused("target: home\ndomain: a.test", { inventory: undefined }),
    "target home needs a hand-written inventory.ini next to it",
  );
  strictEqual(refused("target: hetzner\ndomain: a.test", { hasTerraform: false }), "no terraform/ next to it");
  strictEqual(refused("target: multipass\ndomain: a.test", { secrets: undefined }), "no secrets.yml next to it");
  strictEqual(
    refused("target: multipass\ndomain: a.test", { vars: sealed }),
    "vars.yml is encrypted; it holds settings only — secrets go in secrets.yml",
  );
  strictEqual(
    refused("target: home\ndomain: a.test", { secrets: "admin: admin\n" }),
    "target home requires a SOPS-encrypted secrets.yml",
  );
  strictEqual(
    refused("target: hetzner\ndomain: a.test", { secrets: "$ANSIBLE_VAULT;1.1;AES256\n" }),
    "secrets.yml is an Ansible Vault; kayra reads SOPS now (see Upgrading to 0.21 in kayra's docs)",
  );
  strictEqual(refused("target: hetzner\ndomain: a.test\nvault: true"), "server.yml: 'vault' is not a key it knows");
  strictEqual(refused("target: multipass\ndomain: a.test", { secrets: "admin: admin\n" }), "accepted");
});

test("an app's config is plaintext in apps/, its secrets in secrets.yml", () => {
  const prod = (file: string, text: string) =>
    refused("target: hetzner\ndomain: a.test", { appValues: [{ file, text }] });
  strictEqual(prod("shop.yml", "FLAG: on\n"), "accepted");
  strictEqual(prod("shop.yml", sealed), "apps/shop.yml is encrypted; it holds config only — secrets go in secrets.yml, under app_secrets.shop");
  strictEqual(prod("shop.secrets.yml", sealed), "apps/shop.secrets.yml: an app's secrets go in secrets.yml, under app_secrets.shop");
});

test("an app lives in its own repo, cloned over HTTPS, its root inside it", () => {
  const app = (entry: string) => refused(`target: multipass\ndomain: a.test\napps: [${entry}]`);
  strictEqual(app("{name: shop, repo: git@x.test:s.git}"), "app shop: repo must be an https:// URL (or http:// on multipass)");
  strictEqual(app("{name: shop, path: shop}"), "app shop: repo is required");
  strictEqual(app("{name: shop, repo: http://192.0.2.1:8000/s.git}"), "accepted");
  strictEqual(
    refused("target: hetzner\ndomain: a.test\napps: [{name: shop, repo: http://x.test/s.git}]"),
    "app shop: repo must be an https:// URL",
  );
  strictEqual(app("{name: shop, repo: https://x.test/s.git, path: ../up}"), "app shop: path must stay inside its repo");
  const apps = server("a", "target: multipass\ndomain: a.test\napps: [{name: shop, repo: https://x.test/s.git, ref: main}]").apps;
  deepStrictEqual(apps, [{ name: "shop", repo: "https://x.test/s.git", path: ".", entry: { name: "shop", repo: "https://x.test/s.git", ref: "main" } }]);
  strictEqual(JSON.stringify(apps[0]?.entry), '{"name":"shop","repo":"https://x.test/s.git","ref":"main"}');
});

test("server.yml is parsed by its schema, the one editors check it with", () => {
  const app = (entry: string) => refused(`target: multipass\ndomain: a.test\napps: [${entry}]`);
  strictEqual(app("{name: Shop, repo: https://x.test/s.git}"), "app Shop: 'Shop' is not an app name (lowercase letters, digits, dashes)");
  strictEqual(app("{repo: https://x.test/s.git}"), "app #1: name is required");
  strictEqual(app("{name: shop, repo: https://x.test/s.git, branch: main}"), "server.yml: 'branch' is not a key it knows (in apps.0)");
  strictEqual(refused("target: multipass\ndomain: A.test"), "'A.test' is not a domain");
  strictEqual(refused("target: multipass\ndomain: a.test\napps: shop"), "apps must be a list");
});

test("secrets.yml: SOPS-encrypted or not, opened with age_key_file under ~ or SOPS's own default", () => {
  deepStrictEqual(server("a", "target: multipass\ndomain: a.test", { secrets: "admin: admin\n" }).secrets, {
    file: "/fleet/servers/a/secrets.yml", encrypted: false, key: undefined,
  });
  strictEqual(server("a", "target: hetzner\ndomain: a.test").secrets.encrypted, true);
  strictEqual(server("a", "target: hetzner\ndomain: a.test\nage_key_file: ~/.config/sops/age/umay.txt").secrets.key, join(homedir(), ".config/sops/age/umay.txt"));
  strictEqual(refused("target: hetzner\ndomain: a.test\nage_key_file: keys.txt"), "age_key_file 'keys.txt' is not an absolute path");
});

test("only a home server builds a VM image, and only when vars.yml has a vm", () => {
  const home = "target: home\ndomain: a.test";
  strictEqual(server("a", home, { vars: "vm:\n  address: 10.0.0.2/24\n  gateway: 10.0.0.1\n  disk: 40G\n" }).buildsVm, true);
  strictEqual(server("a", home).buildsVm, false);
  strictEqual(server("a", "target: hetzner\ndomain: a.test", { vars: "vm:\n  address: 10.0.0.2/24\n  gateway: 10.0.0.1\n  disk: 40G\n" }).buildsVm, false);
});

test("the hosts a server's stacks route, relative to its domain where they are under it", () => {
  deepStrictEqual(
    server("a", "target: home\ndomain: a.test", {
      stacks: [
        { name: "forge", compose: "rule=Host(`git.a.test`) || Host(`ci.a.test`)" },
        { name: "other", compose: "rule=Host(`other.example`)" },
        { name: "empty", compose: undefined },
      ],
    }).stackHosts,
    ["git", "ci", "other.example"],
  );
});

test("DNS-01 is a server whose vars.yml names a provider", () => {
  const home = "target: home\ndomain: a.test";
  strictEqual(server("a", home, { vars: "acme_dns: hetzner\n" }).usesAcmeDns, true);
  strictEqual(server("a", home, { vars: "acme_dns: ''\n" }).usesAcmeDns, false);
  strictEqual(server("a", home).usesAcmeDns, false);
});

test("vars.yml holds the kind's settings and nothing else", () => {
  const platform = (vars: string) => refused("target: multipass\ndomain: a.test", { secrets: "admin: admin\n", vars });
  strictEqual(platform("acme_dns: hetzner\nauthelia_policy: one_factor\n"), "accepted");
  strictEqual(platform("acme_dsn: hetzner\n"), "vars.yml: 'acme_dsn' is not a setting — did you mean 'acme_dns'?");
  strictEqual(platform("edge_routes: []\n"), "vars.yml: 'edge_routes' is not a setting");
  strictEqual(platform("git_token: abc\n"), "vars.yml: 'git_token' is a secret — it goes in secrets.yml");
  strictEqual(
    platform("authelia_policy: three_factor\n"),
    'vars.yml: authelia_policy: Invalid option: expected one of "one_factor"|"two_factor"',
  );
  strictEqual(platform("ansible_port: 2222\n"), "accepted");
  strictEqual(
    refused("kind: edge\ntarget: multipass\ndomain: a.test", { secrets: "x: y\n", vars: "edge_routes: [{subdomains: [git], upstream: 'h:1'}]\n" }),
    "accepted",
  );
});

test("a file that is not valid YAML is an error, not a crash", () => {
  strictEqual(
    refused("target: multipass\ndomain: a.test", { secrets: "admin: admin\n", vars: "a: [1\n" }).startsWith("vars.yml is not valid YAML: "),
    true,
  );
});

test("server.yml holds topology only", () => {
  strictEqual(
    refused("target: multipass\ndomain: a.test\nplatform_ci: true", { secrets: "admin: admin\n" }),
    "server.yml: 'platform_ci' is not a key it knows",
  );
});
