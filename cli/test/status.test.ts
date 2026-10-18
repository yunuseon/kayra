import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
  failure,
  isMachine,
  look,
  statusJson,
  statusView,
  unreadable,
  type Look,
  type Network,
  type Reach,
  type Tofu,
} from "../src/commands/status.ts";
import { err, ok } from "../src/result.ts";
import { flat } from "../src/ui/line.ts";
import { settle } from "../src/ui/terminal.ts";
import { fleet, server } from "./support.ts";

const hetzner = (name: string, apps = "") =>
  server(name, `target: hetzner\ndomain: ${name}.example\nvault: true${apps}`, { inventory: undefined });

// A NAS at home: a hand-written inventory, and a terraform/ holding its backup's storage box.
const nas = server("nas", "kind: nas\ntarget: home\ndomain: home.example\nvault: true");
const forge = server("forge", "target: home\ndomain: forge.example\nvault: true", {
  terraform: false,
  inventory: "[servers]\nforge ansible_host=192.0.2.3 ansible_port=2222 ansible_user=deploy\n",
});
const shop = hetzner("shop", "\napps: [{name: shop, repo: https://x.test/s.git}, {name: blog, repo: https://x.test/b.git}]");
const fresh = hetzner("fresh");
const broken = hetzner("broken");

const states: Readonly<Record<string, ReturnType<Tofu["state"]>>> = {
  shop: Promise.resolve(ok(["module.server.hcloud_firewall.this", "module.server.hcloud_server.this"])),
  fresh: Promise.resolve(ok([])),
  broken: Promise.resolve(err("tofu init needed")),
  nas: Promise.resolve(ok(["hcloud_storage_box.backup"])),
};

const tofu: Tofu = {
  state: (dir) => states[dir.split("/").at(-2) ?? ""] ?? Promise.resolve(err("asked for the wrong server")),
  output: (_dir, name) => Promise.resolve(name === "server_ip" ? "203.0.113.10" : undefined),
};

const answers: Readonly<Record<string, Reach>> = {
  "192.0.2.9:22": { kind: "refused" },
  "192.0.2.3:2222": { kind: "open", ms: 3 },
  "203.0.113.10:22": { kind: "open", ms: 31 },
};

const asked: Network = {
  connect: (host, port) => Promise.resolve(answers[`${host}:${String(port)}`] ?? { kind: "no-answer" }),
  get: (url) =>
    Promise.resolve(
      url === "https://auth.shop.example/api/health"
        ? { kind: "answered", status: 200, ms: 84 }
        : { kind: "bad-certificate", code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
    ),
};

const seen = (network: Network | undefined): Promise<readonly Look[]> => {
  const { initial, updates } = look(fleet(broken, forge, fresh, nas, shop), tofu, network);
  return settle(initial, updates);
};

const plain = (looks: readonly Look[], offline = false, room = Infinity): readonly string[] =>
  statusView(looks, { frame: "*", room, offline }).map(flat);

test("the address comes from the inventory where there is one, else from OpenTofu's state, if it holds a machine", async () => {
  deepStrictEqual(
    (await seen(undefined)).map((each) => [each.server.name, each.machine]),
    [
      ["broken", { kind: "unreadable", reason: "tofu init needed" }],
      ["forge", { kind: "found", address: "192.0.2.3", from: "inventory" }],
      ["fresh", { kind: "not-provisioned" }],
      ["nas", { kind: "found", address: "192.0.2.9", from: "inventory" }],
      ["shop", { kind: "found", address: "203.0.113.10", from: "opentofu" }],
    ],
  );
});

test("a machine is a server OpenTofu created, not a storage box or a data source", () => {
  deepStrictEqual(
    ["hcloud_server.this", "module.vm.multipass_instance.this", "module.s.hcloud_server.this[0]", "hcloud_storage_box.backup", "data.hcloud_server.x"].map(
      isMachine,
    ),
    [true, true, true, false, false],
  );
});

test("status: one table, the probes as they answered; an SSH that refuses is off", async () => {
  deepStrictEqual(plain(await seen(asked)), [
    "SERVER  KIND      TARGET   DOMAIN          ADDRESS           SSH        HTTPS           APPS",
    "broken  platform  hetzner  broken.example  state unreadable  –          untrusted cert",
    "forge   platform  home     forge.example   192.0.2.3         open 3ms   untrusted cert",
    "fresh   platform  hetzner  fresh.example   not provisioned   –          untrusted cert",
    "nas     nas       home     home.example    192.0.2.9         off",
    "shop    platform  hetzner  shop.example    203.0.113.10      open 31ms  200 84ms        shop, blog",
    "",
    "  ✗ broken: OpenTofu's state could not be read: tofu init needed",
    "    → tofu -chdir=servers/broken/terraform init",
  ]);
});

test("--offline: no probes, and no columns for them", async () => {
  const looks = await seen(undefined);
  strictEqual(
    looks.every((each) => each.ssh.kind === "skipped"),
    true,
  );
  deepStrictEqual(plain(looks, true).slice(0, 2), [
    "SERVER  KIND      TARGET   DOMAIN          ADDRESS           APPS",
    "broken  platform  hetzner  broken.example  state unreadable",
  ]);
});

test("while the answers come, their cells spin; on a narrow terminal the apps, then the domains, are cut", () => {
  const { initial } = look(fleet(nas, shop), tofu, asked);
  deepStrictEqual(plain(initial), [
    "SERVER  KIND      TARGET   DOMAIN        ADDRESS          SSH        HTTPS      APPS",
    "nas     nas       home     home.example  192.0.2.9        *        ",
    "shop    platform  hetzner  shop.example  *                *          *          shop, blog",
  ]);
  deepStrictEqual(plain(initial, false, 86).slice(1), [
    "nas     nas       home     home.example  192.0.2.9        *        ",
    "shop    platform  hetzner  shop.example  *                *          *          shop,…",
  ]);
  deepStrictEqual(plain(initial, false, 70).slice(1), [
    "nas     nas       home     home.…  192.0.2.9        *        ",
    "shop    platform  hetzner  shop.…  *                *          *          sho…",
  ]);
});

test("status --json: the documented shape", async () => {
  const looks = await seen(asked);
  deepStrictEqual(statusJson(looks).servers[4], {
    name: "shop",
    kind: "platform",
    target: "hetzner",
    domain: "shop.example",
    apps: ["shop", "blog"],
    machine: { state: "found", address: "203.0.113.10", from: "opentofu", reason: null },
    ssh: { port: 22, state: "open", ms: 31, error: null },
    https: { url: "https://auth.shop.example/api/health", state: "answered", status: 200, ms: 84, error: null },
  });
  deepStrictEqual(statusJson(looks).servers[3]?.https, null);
  deepStrictEqual(statusJson(looks).servers[0]?.machine, { state: "unreadable", address: null, from: null, reason: "tofu init needed" });
});

test("a failed connection, by Node's error code", () => {
  deepStrictEqual(
    ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENOTFOUND", "CERT_HAS_EXPIRED", "ECONNRESET"].map((code) => failure(code).kind),
    ["refused", "no-answer", "unreachable", "unknown-host", "bad-certificate", "failed"],
  );
});

test("tofu's error, in a few words", () => {
  strictEqual(
    unreadable(
      "╷\n│ Error: Required plugins are not installed\n│\n│ The installed provider plugins are not consistent … run \"tofu init\".\n╵\n",
    ),
    "tofu init needed",
  );
  strictEqual(unreadable("╷\n│ Error: Failed to load state: permission denied\n╵\n"), "Failed to load state: permission denied");
  strictEqual(unreadable(""), "tofu failed");
});
