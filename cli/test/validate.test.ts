import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { findings, summary, validateJson, validateView, type Facts, type Finding } from "../src/core/commands/validate.ts";
import { flat } from "../src/core/present/line.ts";
import { server } from "./support.ts";

const shop = server("shop", "target: multipass\ndomain: shop.test\napps: [{name: shop, repo: https://x.test/s.git}]", {
  secrets: "admin: admin\n",
});
const edge = server("edge", "kind: edge\ntarget: multipass\ndomain: a.test", { secrets: "x: y\n" });

const facts = (overrides: Partial<Facts>): Facts => ({
  server: shop,
  vars: {},
  varsText: "",
  secrets: { kind: "readable", values: {} },
  stackDirs: [],
  appConfig: { shop: { FLAG: "on" } },
  appSecrets: { shop: { kind: "readable", values: { PASSWORD: "x" } } },
  manifests: { shop: { name: "shop", compose: ["compose.yml"], subdomains: ["www"], secrets: ["PASSWORD"], config: ["FLAG"] } },
  ...overrides,
});

const marks = { problem: "✗", unchecked: "·", passed: "✓" } as const;
const line = (each: Finding): string => `${marks[each.result]} ${each.text}${each.hint === undefined ? "" : ` → ${each.hint}`}`;
const said = (overrides: Partial<Facts>): readonly string[] => findings(facts(overrides)).map(line);
const problems = (overrides: Partial<Facts>): readonly string[] => said(overrides).filter((each) => !each.startsWith("✓"));

test("a fleet that holds together says what it checked", () => {
  deepStrictEqual(said({}), [
    "✓ secrets.yml: 0 secrets, each a setting or used by vars.yml",
    "✓ app shop: 1 config value and 1 secret, as its app.yml asks",
  ]);
});

test("a secret is a known one, or a helper vars.yml uses", () => {
  deepStrictEqual(problems({ secrets: { kind: "readable", values: { git_token: "t", registry_read: "r" } }, varsText: "x: '{{ registry_read }}'\n" }), []);
  deepStrictEqual(problems({ secrets: { kind: "readable", values: { gti_token: "t", stray: "s" } } }), [
    "✗ secrets.yml: 'gti_token' is no secret of a platform server, and vars.yml does not use it → did you mean 'git_token'?",
    "✗ secrets.yml: 'stray' is no secret of a platform server, and vars.yml does not use it → remove it, or use it in vars.yml",
  ]);
  deepStrictEqual(problems({ secrets: { kind: "locked", reason: "vaulted, and server.yml names no vault_password_file", hint: "set it" } }), [
    "· secrets.yml not checked: vaulted, and server.yml names no vault_password_file → set it",
  ]);
});

test("compose_stacks.stacks and stacks/ name the same stacks", () => {
  deepStrictEqual(problems({ vars: { compose_stacks: { dir: "/s", stacks: ["web", "gone"] } }, stackDirs: ["web", "forgotten"] }), [
    "✗ compose_stacks.stacks: 'gone' has no stacks/gone/compose.yaml → add stacks/gone/compose.yaml, or take 'gone' off the list",
    "✗ stacks/forgotten is not in compose_stacks.stacks, so it never runs → list it in compose_stacks.stacks in vars.yml, or remove the folder",
  ]);
  strictEqual(
    said({ vars: { compose_stacks: { dir: "/s", stacks: ["web"] } }, stackDirs: ["web"] })[1],
    "✓ stacks: 1 stack, each listed in compose_stacks.stacks and in stacks/",
  );
});

test("edge routes name subdomains and an upstream host:port", () => {
  deepStrictEqual(
    problems({ server: edge, appConfig: {}, appSecrets: {}, manifests: {}, vars: { edge_routes: [{ subdomains: ["git", "Bad_Name"], upstream: "10.0.0.2" }] } }),
    [
      "✗ edge_routes[0]: 'Bad_Name' is not a subdomain → lowercase letters, digits and dashes",
      "✗ edge_routes[0]: upstream must be host:port → a host and its port, e.g. 192.168.1.10:8080",
    ],
  );
});

test("an app's values match what its app.yml asks for; a missing secrets file holds none", () => {
  deepStrictEqual(said({ appConfig: { shop: {} }, appSecrets: {} }), [
    "✗ apps/shop.yml: no value for FLAG, which app.yml asks for → add FLAG: … to servers/shop/apps/shop.yml",
    "✗ apps/shop.secrets.yml: no value for PASSWORD, which app.yml asks for → add it to servers/shop/apps/shop.secrets.yml",
    "✓ secrets.yml: 0 secrets, each a setting or used by vars.yml",
  ]);
  deepStrictEqual(problems({ manifests: {} }), ["· app shop not checked: not cloned yet → kayra apps shop clones it"]);
  deepStrictEqual(problems({ manifests: { shop: { name: "other", compose: [], subdomains: [] } } }), [
    "✗ app shop: its app.yml says name other → server.yml and app.yml must name it alike",
  ]);
});

const reports = [
  { server: shop, findings: findings(facts({ appConfig: { shop: {} } })) },
  {
    server: edge,
    findings: findings(facts({ server: edge, appConfig: {}, appSecrets: {}, manifests: {}, secrets: { kind: "locked", reason: "locked" } })),
  },
];

test("validate: each server with its findings and what to do about them, then the summary", () => {
  deepStrictEqual(validateView(reports).map(flat), [
    "✗ shop  platform on multipass",
    "    ✗ apps/shop.yml: no value for FLAG, which app.yml asks for",
    "      → add FLAG: … to servers/shop/apps/shop.yml",
    "    ✓ secrets.yml: 0 secrets, each a setting or used by vars.yml",
    "",
    "· edge  edge on multipass",
    "    · secrets.yml not checked: locked",
    "",
    "✗ 2 servers · 1 problem · 1 not checked",
  ]);
  strictEqual(flat(summary(reports.slice(1))), "· 1 server · no problems · 1 not checked");
  strictEqual(flat(summary([])), "✓ 0 servers · no problems");
});

test("validate --json: the documented shape", () => {
  deepStrictEqual(validateJson(reports), {
    result: "problem",
    problems: 1,
    unchecked: 1,
    servers: [
      {
        name: "shop",
        kind: "platform",
        target: "multipass",
        result: "problem",
        findings: [
          { result: "problem", text: "apps/shop.yml: no value for FLAG, which app.yml asks for", hint: "add FLAG: … to servers/shop/apps/shop.yml" },
          { result: "passed", text: "secrets.yml: 0 secrets, each a setting or used by vars.yml", hint: null },
        ],
      },
      {
        name: "edge",
        kind: "edge",
        target: "multipass",
        result: "unchecked",
        findings: [{ result: "unchecked", text: "secrets.yml not checked: locked", hint: null }],
      },
    ],
  });
});
