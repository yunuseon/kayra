import { deepStrictEqual, ok as assert, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forgeRepo, type ForgeRepo } from "../src/lib/forge-repo.ts";
import { ensureHook, hookApi, hookUrl, type Answer, type Http } from "../src/core/app-hook/hooks.ts";
import { operatorToken, tokenVariable } from "../src/core/app-hook/token.ts";
import { takesWebhooks } from "../src/core/recipes/app-hook.ts";
import { server } from "./support.ts";

type Asked = { readonly url: string; readonly method: string; readonly auth: string | undefined; readonly body: unknown };

/** A forge over HTTP that records each request and answers from `answer`. */
const forge = (answer: (asked: Asked) => Answer) => {
  // eslint-disable-next-line functional/prefer-immutable-types -- the fake forge's recorder
  const asked: Asked[] = [];
  const http: Http = (url, init) => {
    const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
    const request = { url, method: init.method, auth: init.headers["Authorization"], body };
    // eslint-disable-next-line functional/immutable-data -- the fake forge's recorder
    asked.push(request);
    return Promise.resolve(answer(request));
  };
  return { http, asked };
};

const repo = (url: string): ForgeRepo => {
  const found = forgeRepo(url);
  if (found === undefined) throw new Error(`no forge for ${url}`);
  return found;
};

const url = hookUrl("shop.example.com", "shop");
const tokens = { platform: "platform-token", operator: "operator-token" };

test("github: the platform's token reads the repository, the operator's creates a JSON push hook signed with the secret", async () => {
  const { http, asked } = forge((request) =>
    request.method === "POST" ? { status: 201, json: { id: 7, config: { url } } } : { status: 200, json: request.url.endsWith("/hooks") ? [{ id: 1, config: { url: "https://ci.example.com" } }] : {} });
  const done = await ensureHook(hookApi(repo("https://github.com/acme/shop.git"), http), url, tokens, "hook-secret");
  assert(done.ok);
  strictEqual(done.value[1], `✓ push hook created: ${url} (id 7)`);
  deepStrictEqual(asked.map((each) => [each.method, each.url, each.auth]), [
    ["GET", "https://api.github.com/repos/acme/shop", "Bearer platform-token"],
    ["GET", "https://api.github.com/repos/acme/shop/hooks", "Bearer operator-token"],
    ["POST", "https://api.github.com/repos/acme/shop/hooks", "Bearer operator-token"],
  ]);
  deepStrictEqual(asked[2]?.body, { active: true, events: ["push"], config: { url, content_type: "json", secret: "hook-secret", insecure_ssl: "0" } });
});

test("forgejo: its /api/v1 with a token header; the hook there is updated, not added", async () => {
  const { http, asked } = forge((request) =>
    request.method === "PATCH" ? { status: 200, json: { id: 3, config: { url } } } : { status: 200, json: request.url.endsWith("/hooks") ? [{ id: 3, config: { url } }] : {} });
  const done = await ensureHook(hookApi(repo("https://git.example.com/umay/shop.git"), http), url, tokens, "hook-secret");
  assert(done.ok);
  strictEqual(done.value[1], `✓ push hook updated: ${url} (id 3)`);
  strictEqual(asked.at(-1)?.url, "https://git.example.com/api/v1/repos/umay/shop/hooks/3");
  strictEqual(asked.at(-1)?.auth, "token operator-token");
  deepStrictEqual(asked.at(-1)?.body, { active: true, events: ["push"], config: { url, content_type: "json", secret: "hook-secret" } });
});

test("gitlab: the project by its path, the secret as the hook's token, which the deployer checks", async () => {
  const { http, asked } = forge((request) => (request.method === "POST" ? { status: 201, json: { id: 9, url } } : { status: 200, json: request.url.endsWith("/hooks") ? [] : {} }));
  const done = await ensureHook(hookApi(repo("https://gitlab.com/acme/team/shop.git"), http), url, tokens, "hook-secret");
  assert(done.ok);
  strictEqual(asked[0]?.url, "https://gitlab.com/api/v4/projects/acme%2Fteam%2Fshop");
  deepStrictEqual(asked.at(-1)?.body, { url, token: "hook-secret", push_events: true, enable_ssl_verification: true });
});

test("ensureHook: a token that cannot read the repository stops before any hook; two hooks to the deployer are refused", async () => {
  const unreadable = forge(() => ({ status: 404, json: {} }));
  const refused = await ensureHook(hookApi(repo("https://github.com/acme/shop.git"), unreadable.http), url, tokens, "hook-secret");
  assert(!refused.ok && refused.error.includes("cannot read the repository: HTTP 404"));
  strictEqual(unreadable.asked.length, 1);
  const twice = forge(() => ({ status: 200, json: [{ id: 1, config: { url } }, { id: 2, config: { url } }] }));
  const two = await ensureHook(hookApi(repo("https://github.com/acme/shop.git"), twice.http), url, tokens, "hook-secret");
  assert(!two.ok && two.error.includes("2 hooks"));
  assert(!twice.asked.some((each) => each.method !== "GET"));
});

test("the operator's token: KAYRA_FORGE_TOKEN_<HOST> first, then tea's login file for a Forgejo; none is no error", () => {
  const home = mkdtempSync(join(tmpdir(), "kayra-token-"));
  try {
    const forgejo = repo("https://git.example.com/umay/shop.git");
    strictEqual(tokenVariable("git.example.com"), "KAYRA_FORGE_TOKEN_GIT_EXAMPLE_COM");
    deepStrictEqual(operatorToken(forgejo, { KAYRA_FORGE_TOKEN_GIT_EXAMPLE_COM: "from-env" }, home), { token: "from-env", from: "KAYRA_FORGE_TOKEN_GIT_EXAMPLE_COM" });
    strictEqual(operatorToken(forgejo, {}, home), undefined);
    mkdirSync(join(home, ".config", "tea"), { recursive: true });
    writeFileSync(join(home, ".config", "tea", "config.yml"), "logins:\n  - name: other\n    url: https://elsewhere.example\n    token: nope\n  - name: home\n    url: https://git.example.com\n    token: from-tea\n");
    deepStrictEqual(operatorToken(forgejo, {}, home), { token: "from-tea", from: "tea's login" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("takesWebhooks: a platform server by default; not with webhooks: false, not on multipass", () => {
  const prod = "kind: platform\ntarget: hetzner\ndomain: shop.example.com\n";
  strictEqual(takesWebhooks(server("prod", prod)).ok, true);
  const polling = takesWebhooks(server("prod", prod, { vars: "webhooks: false\n" }));
  assert(!polling.ok && polling.error.includes("deploy_poll"));
  strictEqual(takesWebhooks(server("lab", "kind: platform\ntarget: multipass\ndomain: lab.test\n")).ok, false);
});
