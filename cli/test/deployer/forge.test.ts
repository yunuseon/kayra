import { deepStrictEqual, ok as assert, strictEqual } from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { forge, forgeRepo, signed, type CommitStatus, type Fetch, type ForgeRepo } from "../../src/deployer/forge.ts";
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

const repo = (url: string): ForgeRepo => {
  const parsed = forgeRepo(url);
  if (parsed === undefined) throw new Error(`no forge for ${url}`);
  return parsed;
};

const githubRepo = repo(shop.repo);
const forgejoRepo = repo("http://forgejo:3000/umay/Umay.git");
const gitlabRepo = repo("https://gitlab.com/acme/web/shop.git");

test("forgeRepo: GitHub and GitLab by their hosts, a Forgejo for any other, nothing for an SSH URL", () => {
  deepStrictEqual(githubRepo, { kind: "github", origin: "https://github.com", owner: "example", name: "shop" });
  deepStrictEqual(forgejoRepo, { kind: "forgejo", origin: "http://forgejo:3000", owner: "umay", name: "Umay" });
  deepStrictEqual(forgeRepo("https://git.example.com/o/r/"), { kind: "forgejo", origin: "https://git.example.com", owner: "o", name: "r" });
  deepStrictEqual(gitlabRepo, { kind: "gitlab", origin: "https://gitlab.com", owner: "acme/web", name: "shop" });
  strictEqual(forgeRepo("git@github.com:example/shop.git"), undefined);
});

test("github: POSTs to the REST API with a bearer token", async () => {
  const fake = fakeFetch(201);
  deepStrictEqual(await forge(githubRepo, "t", fake.fetch).postStatus(commit("a"), status), ok(undefined));
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
  deepStrictEqual(await forge(forgejoRepo, "t", fake.fetch).postStatus(commit("a"), status), ok(undefined));
  deepStrictEqual(fake.calls, [
    {
      url: `http://forgejo:3000/api/v1/repos/umay/Umay/statuses/${commit("a")}`,
      headers: { Authorization: "token t", "Content-Type": "application/json" },
      body,
    },
  ]);
});

test("gitlab: POSTs to the project's path on /api/v4, a failure as failed", async () => {
  const fake = fakeFetch(201);
  deepStrictEqual(await forge(gitlabRepo, "t", fake.fetch).postStatus(commit("a"), { ...status, state: "failure" }), ok(undefined));
  deepStrictEqual(fake.calls, [
    {
      url: `https://gitlab.com/api/v4/projects/acme%2Fweb%2Fshop/statuses/${commit("a")}`,
      headers: { "PRIVATE-TOKEN": "t", "Content-Type": "application/json" },
      body: { state: "failed", name: "kayra/deploy", description: "Deployed", target_url: status.target },
    },
  ]);
});

test("postStatus: an HTTP error or no answer is a failure, on every forge", async () => {
  const answers = await Promise.all(
    [githubRepo, forgejoRepo, gitlabRepo].flatMap((repo) =>
      [404, undefined].map((answer) => forge(repo, "t", fakeFetch(answer).fetch).postStatus(commit("a"), status)),
    ),
  );
  deepStrictEqual(answers, [err("HTTP 404"), err("no answer"), err("HTTP 404"), err("no answer"), err("HTTP 404"), err("no answer")]);
});

test("webhooks: each forge's own proof of the secret, nothing unsigned or another forge's", () => {
  const push = Buffer.from(JSON.stringify({ ref: "refs/heads/main" }));
  const hex = createHmac("sha256", "s3cret").update(push).digest("hex");
  assert(signed(githubRepo, "s3cret", push, { "x-hub-signature-256": `sha256=${hex}` }));
  assert(!signed(githubRepo, "s3cret", push, { "x-forgejo-signature": hex }));
  assert(!signed(githubRepo, "other", push, { "x-hub-signature-256": `sha256=${hex}` }));
  assert(signed(forgejoRepo, "s3cret", push, { "x-forgejo-signature": hex }));
  assert(signed(forgejoRepo, "s3cret", push, { "x-gitea-signature": hex }));
  assert(signed(forgejoRepo, "s3cret", push, { "x-hub-signature-256": `sha256=${hex}` }));
  assert(!signed(forgejoRepo, "", push, { "x-forgejo-signature": hex }));
  assert(signed(gitlabRepo, "s3cret", push, { "x-gitlab-token": "s3cret" }));
  assert(!signed(gitlabRepo, "s3cret", push, { "x-gitlab-token": "s3cre" }));
  assert(!signed(gitlabRepo, "", push, { "x-gitlab-token": "" }));
  assert(!signed(gitlabRepo, "s3cret", push, { "x-hub-signature-256": `sha256=${hex}` }));
  deepStrictEqual([githubRepo, forgejoRepo, gitlabRepo].map((repo) => signed(repo, "s3cret", push, {})), [false, false, false]);
});
