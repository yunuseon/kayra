import { deepStrictEqual, ok as assert, strictEqual } from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { appOwner, jobOwner } from "../../src/deployer/brand.ts";
import { appJwt, githubIssues, type GithubIssueWorld } from "../../src/deployer/forges/issues.ts";
import { decide, parseNotify, type RunEnd } from "../../src/deployer/forges/notify.ts";
import type { Request, Why } from "../../src/deployer/runs/queue.ts";
import { ok } from "../../src/lib/result.ts";
import { commit, name } from "./support.ts";

const deployOf = (why: Why): Request => ({ owner: appOwner(name("shop")), work: { kind: "deploy", app: name("shop"), ref: "main", why } });
const end = (request: Request, success: boolean): RunEnd => ({ server: "shop-prod", request, ok: success, sha: commit("a"), page: "https://deploy.x/runs/shop/1" });

test("decide: a failed push or poll raises, a failed manual deploy does not, any success resolves", () => {
  const raised = decide(end(deployOf("push"), false));
  assert(raised.kind === "raise");
  strictEqual(raised.alert.key, "shop");
  strictEqual(raised.alert.title, `shop-prod: shop did not deploy at ${commit("a").slice(0, 12)}`);
  assert(raised.alert.body.includes("https://deploy.x/runs/shop/1"));
  strictEqual(decide(end(deployOf("poll"), false)).kind, "raise");
  strictEqual(decide(end(deployOf("deploy"), false)).kind, "none");
  strictEqual(decide(end(deployOf("rollback"), false)).kind, "none");
  deepStrictEqual(decide(end(deployOf("rollback"), true)), { kind: "resolve", key: "shop", note: "Recovered: https://deploy.x/runs/shop/1" });
  const job: Request = { owner: jobOwner("gc"), work: { kind: "job", job: "gc", dryRun: false, why: "schedule" } };
  const failedJob = decide(end(job, false));
  assert(failedJob.kind === "raise");
  strictEqual(failedJob.alert.key, "_gc");
});

test("parseNotify: none without a setting, github-issue with repository and app_id, anything else refused", () => {
  deepStrictEqual(parseNotify(undefined), ok({ kind: "none" }));
  deepStrictEqual(parseNotify(""), ok({ kind: "none" }));
  deepStrictEqual(parseNotify('{"kind":"github-issue","repository":"o/r","app_id":42}'), ok({ kind: "github-issue", repository: "o/r", appId: "42" }));
  strictEqual(parseNotify('{"kind":"ntfy"}').ok, false);
  strictEqual(parseNotify('{"kind":"github-issue","repository":"nope","app_id":1}').ok, false);
  strictEqual(parseNotify("{").ok, false);
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

test("appJwt: RS256 over header.payload, the app as issuer, nine minutes", () => {
  const [header = "", payload = "", signature = ""] = appJwt("42", pem, 1000).split(".");
  const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString());
  deepStrictEqual(claims, { iat: 940, exp: 1540, iss: "42" });
  assert(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, "base64url")));
});

/** A fake GitHub that records calls; the app is installed, issues get number 7. */
const fakeGithub = (): { readonly world: GithubIssueWorld; readonly calls: readonly string[] } => {
  // eslint-disable-next-line functional/prefer-immutable-types -- the fake's recorder
  const calls: string[] = [];
  const open = new Map<string, number>();
  const world: GithubIssueWorld = {
    fetch: (url, init) => {
      const path = url.replace("https://api.github.com", "");
      // eslint-disable-next-line functional/immutable-data -- the fake's recorder
      calls.push(`${init.method} ${path}`);
      if (path.endsWith("/installation")) return Promise.resolve({ status: 200, json: { id: 5 } });
      if (path.endsWith("/access_tokens")) return Promise.resolve({ status: 201, json: { token: "t" } });
      if (init.method === "POST" && path.endsWith("/issues")) return Promise.resolve({ status: 201, json: { number: 7 } });
      return Promise.resolve({ status: 200, json: {} });
    },
    privateKey: () => ok(pem),
    now: () => 1_000_000,
    openIssue: (key) => open.get(key),
    remember: (key, issue) => {
      // eslint-disable-next-line functional/immutable-data -- the fake's state file
      if (issue === undefined) open.delete(key);
      // eslint-disable-next-line functional/immutable-data -- the fake's state file
      else open.set(key, issue);
    },
  };
  return { world, calls };
};

test("github issues: one issue per key while it lasts; resolve comments and closes it", async () => {
  const { world, calls } = fakeGithub();
  const notifier = githubIssues("o/r", "42", world);
  deepStrictEqual(await notifier.resolve("shop", "fine"), ok(undefined));
  deepStrictEqual(calls, []);
  await notifier.raise({ key: "shop", title: "t", body: "b" });
  await notifier.raise({ key: "shop", title: "t again", body: "b" });
  deepStrictEqual(calls, ["GET /repos/o/r/installation", "POST /app/installations/5/access_tokens", "POST /repos/o/r/issues"]);
  strictEqual(world.openIssue("shop"), 7);
  await notifier.resolve("shop", "Recovered");
  deepStrictEqual(calls.slice(3), [
    "GET /repos/o/r/installation",
    "POST /app/installations/5/access_tokens",
    "POST /repos/o/r/issues/7/comments",
    "PATCH /repos/o/r/issues/7",
  ]);
  strictEqual(world.openIssue("shop"), undefined);
});
