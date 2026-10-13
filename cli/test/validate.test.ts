import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { findings, type Facts } from "../src/commands/validate.ts";
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

const said = (overrides: Partial<Facts>) => findings(facts(overrides)).map((each) => `${each.problem ? "✗" : "·"} ${each.text}`);

test("a fleet that holds together has nothing to say", () => {
  deepStrictEqual(said({}), []);
});

test("a secret is a known one, or a helper vars.yml uses", () => {
  deepStrictEqual(said({ secrets: { kind: "readable", values: { git_token: "t", registry_read: "r" } }, varsText: "x: '{{ registry_read }}'\n" }), []);
  deepStrictEqual(said({ secrets: { kind: "readable", values: { gti_token: "t" } } }), [
    "✗ secrets.yml: 'gti_token' is no secret of a platform server, and vars.yml does not use it",
  ]);
  deepStrictEqual(said({ secrets: { kind: "locked", reason: "vaulted, and no vault password file here" } }), [
    "· secrets.yml not checked: vaulted, and no vault password file here",
  ]);
});

test("compose_stacks.stacks and stacks/ name the same stacks", () => {
  deepStrictEqual(said({ vars: { compose_stacks: { dir: "/s", stacks: ["web", "gone"] } }, stackDirs: ["web", "forgotten"] }), [
    "✗ compose_stacks.stacks: 'gone' has no stacks/gone/compose.yaml",
    "✗ stacks/forgotten is not in compose_stacks.stacks, so it never runs",
  ]);
});

test("edge routes name subdomains and an upstream host:port", () => {
  deepStrictEqual(
    said({ server: edge, appConfig: {}, appSecrets: {}, manifests: {}, vars: { edge_routes: [{ subdomains: ["git", "Bad_Name"], upstream: "10.0.0.2" }] } }),
    ["✗ edge_routes[0]: 'Bad_Name' is not a subdomain", "✗ edge_routes[0]: upstream must be host:port"],
  );
});

test("an app's values match what its app.yml asks for", () => {
  deepStrictEqual(said({ appConfig: { shop: {} }, appSecrets: { shop: { kind: "readable", values: {} } } }), [
    "✗ apps/shop.yml: no value for FLAG, which app.yml asks for",
    "✗ apps/shop.secrets.yml: no value for PASSWORD, which app.yml asks for",
  ]);
  deepStrictEqual(said({ manifests: {} }), ["· app shop not checked: not cloned yet (kayra apps clones it)"]);
  deepStrictEqual(said({ manifests: { shop: { name: "other", compose: [], subdomains: [] } } }), [
    "✗ app shop: its app.yml says name other",
  ]);
});
