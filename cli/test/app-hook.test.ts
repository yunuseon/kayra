import { deepStrictEqual, ok as assert, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { github, type Get } from "../src/core/app-hook/github.ts";
import { ensureHook, githubRepo, hookUrl, type Forge, type Hook } from "../src/core/app-hook/hooks.ts";
import { err, ok } from "../src/lib/result.ts";

const repo = { owner: "acme", name: "shop" };
const url = hookUrl("shop.example.com", "shop");
const secrets = { token: "platform-token", webhook: "hook-secret" };

/** A forge that records what was saved; `existing` are its hooks, `readable` whether the token reads the repo. */
const forge = (existing: readonly Hook[], readable = true) => {
  // eslint-disable-next-line functional/prefer-immutable-types -- the fake forge's recorder
  const saved: { url: string; secret: string; id: number | undefined }[] = [];
  const fake: Forge = {
    readable: () => Promise.resolve(readable ? ok(true) : err("the platform's git_token cannot read acme/shop (404)")),
    hooks: () => Promise.resolve(ok(existing)),
    save: (_, to, secret, id) => {
      // eslint-disable-next-line functional/immutable-data -- the fake forge's recorder
      saved.push({ url: to, secret, id });
      return Promise.resolve(ok({ id: id ?? 7, url: to }));
    },
  };
  return { fake, saved };
};

test("githubRepo: owner and name of a github.com URL, nothing for another forge or SSH", () => {
  deepStrictEqual(githubRepo("https://github.com/acme/shop.git"), repo);
  deepStrictEqual(githubRepo("https://github.com/acme/shop"), repo);
  strictEqual(githubRepo("https://git.example.com/acme/shop.git"), undefined);
  strictEqual(githubRepo("git@github.com:acme/shop.git"), undefined);
  strictEqual(url, "https://deploy.shop.example.com/hook/shop");
});

test("ensureHook: creates the push hook where there is none, with the platform's secret", async () => {
  const { fake, saved } = forge([{ id: 1, url: "https://ci.example.com/hook" }]);
  const done = await ensureHook(fake, repo, url, secrets);
  assert(done.ok);
  deepStrictEqual(saved, [{ url, secret: "hook-secret", id: undefined }]);
  assert(done.value[1]?.startsWith("✓ push hook created"));
});

test("ensureHook: updates the one there is, never adds a second; two to the same URL are refused", async () => {
  const one = forge([{ id: 3, url }]);
  assert((await ensureHook(one.fake, repo, url, secrets)).ok);
  deepStrictEqual(one.saved, [{ url, secret: "hook-secret", id: 3 }]);
  const two = forge([{ id: 3, url }, { id: 4, url }]);
  strictEqual((await ensureHook(two.fake, repo, url, secrets)).ok, false);
  deepStrictEqual(two.saved, []);
});

test("ensureHook: a token that cannot read the repository stops before any hook is touched", async () => {
  const { fake, saved } = forge([], false);
  deepStrictEqual(await ensureHook(fake, repo, url, secrets), err("the platform's git_token cannot read acme/shop (404)"));
  deepStrictEqual(saved, []);
});

test("github: the platform's token reads the repository through the REST API, as a bearer", async () => {
  // eslint-disable-next-line functional/prefer-immutable-types -- the fake fetch's recorder
  const asked: { url: string; auth: string | undefined }[] = [];
  const fetchFake: Get = (to, headers) => {
    // eslint-disable-next-line functional/immutable-data -- the fake fetch's recorder
    asked.push({ url: to, auth: headers["authorization"] });
    const status = to.endsWith("/private") ? 404 : 200;
    return Promise.resolve({ ok: status === 200, status });
  };
  assert((await github(fetchFake).readable(repo, "t0ken")).ok);
  deepStrictEqual(asked, [{ url: "https://api.github.com/repos/acme/shop", auth: "Bearer t0ken" }]);
  const refused = await github(fetchFake).readable({ owner: "acme", name: "private" }, "t0ken");
  assert(!refused.ok && refused.error.includes("(404)"));
});
