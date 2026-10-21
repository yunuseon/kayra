import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findings, type Facts, type Finding } from "../src/core/validation/findings.ts";
import { summary, validateView } from "../src/clients/cli/validate.ts";
import { validateJson } from "../src/clients/wire/validate.ts";
import { flat } from "../src/core/text/spans.ts";
import { gather } from "../src/core/validation/facts.ts";
import { absolutePath, fleetRoot, serverDir, serverName } from "../src/core/fleet/brand.ts";
import { must, server } from "./support.ts";

const shop = server("shop", "target: multipass\ndomain: shop.test\napps: [{name: shop, repo: https://x.test/s.git}]", {
  secrets: "admin: admin\n",
});
const edge = server("edge", "kind: edge\ntarget: multipass\ndomain: a.test", { secrets: "x: y\n" });

const facts = (overrides: Partial<Facts>): Facts => ({
  server: shop,
  vars: {},
  varsText: "",
  secrets: { kind: "readable", values: {} },
  recipients: undefined,
  stackDirs: [],
  appConfig: { shop: { FLAG: "on" } },
  appSecrets: { shop: { kind: "readable", values: { PASSWORD: "x" } } },
  terraform: {},
  manifests: { shop: { name: "shop", compose: ["compose.yml"], routes: [{ host: "www", service: "web", port: 3000 }], secrets: ["PASSWORD"], config: ["FLAG"] } },
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
  deepStrictEqual(problems({ secrets: { kind: "locked", reason: "is not valid YAML", hint: "fix it" } }), [
    "· secrets.yml not checked: is not valid YAML → fix it",
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

test("an app's values match what its app.yml asks for; an app without app_secrets has none", () => {
  deepStrictEqual(said({ appConfig: { shop: {} }, appSecrets: {} }), [
    "✗ apps/shop.yml: no value for FLAG, which app.yml asks for → add FLAG: … to servers/shop/apps/shop.yml",
    "✗ secrets.yml: no app_secrets.shop.PASSWORD, which app.yml asks for → kayra app secret generate shop shop PASSWORD (or app secret import)",
    "✓ secrets.yml: 0 secrets, each a setting or used by vars.yml",
  ]);
  deepStrictEqual(problems({ manifests: {} }), ["· app shop not checked: not cloned yet → kayra apps shop clones it"]);
  deepStrictEqual(problems({ manifests: { shop: { name: "other", compose: [] } } }), [
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

test("secrets.yml is encrypted to exactly the recipients .sops.yaml names for it", () => {
  deepStrictEqual(problems({ recipients: { wanted: ["age1a", "age1b"], actual: ["age1a", "age1b"] } }), []);
  deepStrictEqual(problems({ recipients: { wanted: ["age1a", "age1b"], actual: ["age1a", "age1old"] } }), [
    "✗ secrets.yml is not encrypted to age1b, which .sops.yaml names → sops updatekeys servers/shop/secrets.yml",
    "✗ secrets.yml is encrypted to age1old, which .sops.yaml no longer names → sops updatekeys servers/shop/secrets.yml, then rotate what that key could read",
  ]);
  deepStrictEqual(problems({ recipients: { wanted: undefined, actual: ["age1a"] } }), [
    "✗ secrets.yml: no creation rule in .sops.yaml matches it → add a rule whose path_regex matches it, with its age recipients",
  ]);
});

test("validate reads secrets.yml without its key: every key, each value a stand-in of its type, and its .sops.yaml rule", async (t) => {
  const encrypted = [
    "git_token: ENC[AES256_GCM,data:AA==,iv:AA==,tag:AA==,type:str]",
    "app_secrets:",
    "    shop:",
    "        PASSWORD: ENC[AES256_GCM,data:AA==,iv:AA==,tag:AA==,type:str]",
    "terraform:",
    "    hcloud_token: ENC[AES256_GCM,data:AA==,iv:AA==,tag:AA==,type:str]",
    "    servers: ENC[AES256_GCM,data:AA==,iv:AA==,tag:AA==,type:int]",
    "sops:",
    "    age:",
    "        - recipient: age1b",
    "        - recipient: age1a",
    "",
  ].join("\n");
  const dir = mkdtempSync(join(tmpdir(), "kayra-validate-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, ".sops.yaml"), "creation_rules:\n  - path_regex: ^dns/secrets\\.yml$\n    age: age1dns\n  - path_regex: ^servers/[^/]+/secrets\\.yml$\n    age: >-\n      age1b,\n      age1a\n");
  const fleetDir = fleetRoot(must(absolutePath(dir)));
  const prod = server("shop", "target: hetzner\ndomain: shop.test\napps: [{name: shop, repo: https://x.test/s.git}]", { secrets: encrypted, dir: serverDir(fleetDir, must(serverName("shop"))) });
  const gathered = await gather(fleetDir, prod);
  deepStrictEqual(gathered.secrets, { kind: "readable", values: { git_token: "(encrypted)" } });
  deepStrictEqual(gathered.appSecrets, { shop: { kind: "readable", values: { PASSWORD: "(encrypted)" } } });
  deepStrictEqual(gathered.terraform, { hcloud_token: "(encrypted)", servers: 0 });
  deepStrictEqual(gathered.recipients, { wanted: ["age1a", "age1b"], actual: ["age1a", "age1b"] });
});
