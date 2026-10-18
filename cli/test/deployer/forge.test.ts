import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { forge, forgeRepo, type CommitStatus, type Fetch } from "../../src/deployer/forge.ts";
import { err, ok } from "../../src/result.ts";
import { commit, shop } from "./support.ts";

type Call = { readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly body: unknown };

/** A fake forge that records each request and answers with `status`, or not at all. */
const fakeFetch = (status: number | undefined): { readonly fetch: Fetch; readonly calls: readonly Call[] } => {
  // eslint-disable-next-line functional/prefer-immutable-types -- the fake's recorder
  const calls: Call[] = [];
  const fetch: Fetch = (url, init) => {
    // eslint-disable-next-line functional/immutable-data -- the fake's recorder
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return status === undefined ? Promise.reject(new Error("refused")) : Promise.resolve({ ok: status >= 200 && status < 300, status });
  };
  return { fetch, calls };
};

const status: CommitStatus = { context: "kayra/deploy", state: "success", description: "Deployed", target: "https://deploy.x/runs/shop/1" };
const body = { state: "success", context: "kayra/deploy", description: "Deployed", target_url: status.target };

test("forgeRepo: GitHub for github.com, a Forgejo for any other host, nothing for an SSH URL", () => {
  deepStrictEqual(forgeRepo(shop.repo), { kind: "github", origin: "https://github.com", owner: "example", name: "shop" });
  deepStrictEqual(forgeRepo("http://forgejo:3000/umay/Umay.git"), { kind: "forgejo", origin: "http://forgejo:3000", owner: "umay", name: "Umay" });
  deepStrictEqual(forgeRepo("https://git.example.com/o/r/"), { kind: "forgejo", origin: "https://git.example.com", owner: "o", name: "r" });
  strictEqual(forgeRepo("git@github.com:example/shop.git"), undefined);
});

test("github: POSTs to the REST API with a bearer token", async () => {
  const fake = fakeFetch(201);
  const repo = forgeRepo(shop.repo);
  deepStrictEqual(repo === undefined ? undefined : await forge(repo, "t", fake.fetch).postStatus(commit("a"), status), ok(undefined));
  deepStrictEqual(fake.calls, [
    {
      url: `https://api.github.com/repos/example/shop/statuses/${commit("a")}`,
      headers: { Authorization: "Bearer t", Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body,
    },
  ]);
});

test("forgejo: POSTs to the host's /api/v1 with a token", async () => {
  const fake = fakeFetch(201);
  const repo = forgeRepo("http://forgejo:3000/umay/Umay.git");
  deepStrictEqual(repo === undefined ? undefined : await forge(repo, "t", fake.fetch).postStatus(commit("a"), status), ok(undefined));
  deepStrictEqual(fake.calls, [
    {
      url: `http://forgejo:3000/api/v1/repos/umay/Umay/statuses/${commit("a")}`,
      headers: { Authorization: "token t", "Content-Type": "application/json" },
      body,
    },
  ]);
});

test("postStatus: an HTTP error or no answer is a failure, on either forge", async () => {
  const repos = [forgeRepo(shop.repo), forgeRepo("http://forgejo:3000/umay/Umay.git")].flatMap((repo) => (repo === undefined ? [] : [repo]));
  strictEqual(repos.length, 2);
  const answers = await Promise.all(
    repos.flatMap((repo) => [404, undefined].map((answer) => forge(repo, "t", fakeFetch(answer).fetch).postStatus(commit("a"), status))),
  );
  deepStrictEqual(answers, [err("HTTP 404"), err("no answer"), err("HTTP 404"), err("no answer")]);
});
