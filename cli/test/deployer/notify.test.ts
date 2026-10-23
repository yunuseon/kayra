import { deepStrictEqual, ok as assert, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { appOwner, jobOwner } from "../../src/deployer/brand.ts";
import { decide, parseNotify, type RunEnd } from "../../src/deployer/forges/notify.ts";
import { ntfy, type NtfyWorld } from "../../src/deployer/forges/ntfy.ts";
import type { Request, Why } from "../../src/deployer/runs/queue.ts";
import { err, ok } from "../../src/lib/result.ts";
import { commit, name, rid } from "./support.ts";

const deployOf = (why: Why): Request => ({ id: rid, owner: appOwner(name("shop")), work: { kind: "deploy", app: name("shop"), ref: "main", why } });
const end = (request: Request, success: boolean): RunEnd => ({ server: "shop-prod", request, ok: success, sha: commit("a"), page: "https://deploy.x/runs/shop/1" });

test("decide: a failed push, poll or restore raises, a failed manual deploy does not, any success resolves", () => {
  const raised = decide(end(deployOf("push"), false));
  assert(raised.kind === "raise");
  strictEqual(raised.alert.key, "shop");
  strictEqual(raised.alert.title, `shop-prod: shop did not deploy at ${commit("a").slice(0, 12)}`);
  assert(raised.alert.body.includes("https://deploy.x/runs/shop/1"));
  strictEqual(decide(end(deployOf("poll"), false)).kind, "raise");
  strictEqual(decide(end(deployOf("restore"), false)).kind, "raise");
  strictEqual(decide(end(deployOf("deploy"), false)).kind, "none");
  strictEqual(decide(end(deployOf("rollback"), false)).kind, "none");
  deepStrictEqual(decide(end(deployOf("rollback"), true)), { kind: "resolve", key: "shop", note: "Recovered: https://deploy.x/runs/shop/1" });
  const job: Request = { id: rid, owner: jobOwner("gc"), work: { kind: "job", job: "gc", dryRun: false, why: "schedule" } };
  const failedJob = decide(end(job, false));
  assert(failedJob.kind === "raise");
  strictEqual(failedJob.alert.key, "_gc");
});

test("parseNotify: none without a setting, ntfy with url and topic, anything else refused", () => {
  deepStrictEqual(parseNotify(undefined), ok({ kind: "none" }));
  deepStrictEqual(parseNotify(""), ok({ kind: "none" }));
  deepStrictEqual(parseNotify('{"kind":"ntfy","url":"https://ntfy.example/","topic":"alerts"}'), ok({ kind: "ntfy", url: "https://ntfy.example", topic: "alerts" }));
  strictEqual(parseNotify('{"kind":"ntfy","url":"https://ntfy.example"}').ok, false);
  strictEqual(parseNotify('{"kind":"ntfy","url":"https://ntfy.example/alerts","topic":"alerts"}').ok, false);
  strictEqual(parseNotify('{"kind":"ntfy","url":"https://ntfy.example","topic":"a/b"}').ok, false);
  strictEqual(parseNotify('{"kind":"github-issue","repository":"o/r","app_id":42}').ok, false);
  strictEqual(parseNotify("{").ok, false);
});

/** A fake ntfy that records what was published; `status` is what it answers. */
const fakeNtfy = (status: number): { readonly world: NtfyWorld; readonly sent: readonly unknown[]; readonly auth: readonly string[] } => {
  // eslint-disable-next-line functional/prefer-immutable-types -- the fake's recorder
  const sent: unknown[] = [];
  // eslint-disable-next-line functional/prefer-immutable-types -- the fake's recorder
  const auth: string[] = [];
  const open = new Map<string, string>();
  const world: NtfyWorld = {
    fetch: (_url, init) => {
      // eslint-disable-next-line functional/immutable-data -- the fake's recorder
      sent.push(JSON.parse(init.body));
      // eslint-disable-next-line functional/immutable-data -- the fake's recorder
      auth.push(init.headers["Authorization"] ?? "");
      return Promise.resolve({ status });
    },
    token: () => ok("tk"),
    openAlert: (key) => open.get(key),
    remember: (key, title) => {
      // eslint-disable-next-line functional/immutable-data -- the fake's state file
      if (title === undefined) open.delete(key);
      // eslint-disable-next-line functional/immutable-data -- the fake's state file
      else open.set(key, title);
    },
  };
  return { world, sent, auth };
};

test("ntfy: one message when an alert opens, one when it is resolved, none in between", async () => {
  const { world, sent, auth } = fakeNtfy(200);
  const notifier = ntfy("https://ntfy.example", "alerts", world);
  deepStrictEqual(await notifier.resolve("shop", "fine"), ok(undefined));
  deepStrictEqual(sent, []);
  await notifier.raise({ key: "shop", title: "shop-prod: shop did not deploy", body: "b" });
  await notifier.raise({ key: "shop", title: "again", body: "b" });
  deepStrictEqual(sent, [{ topic: "alerts", title: "shop-prod: shop did not deploy", message: "b", priority: 4, tags: ["rotating_light"] }]);
  strictEqual(world.openAlert("shop"), "shop-prod: shop did not deploy");
  await notifier.resolve("shop", "Recovered");
  deepStrictEqual(sent.slice(1), [{ topic: "alerts", title: "Resolved: shop-prod: shop did not deploy", message: "Recovered", priority: 3, tags: ["white_check_mark"] }]);
  deepStrictEqual(auth, ["Bearer tk", "Bearer tk"]);
  strictEqual(world.openAlert("shop"), undefined);
});

test("ntfy: a message ntfy refuses leaves the alert unsent, so the next run tries again", async () => {
  const { world } = fakeNtfy(403);
  const notifier = ntfy("https://ntfy.example", "alerts", world);
  deepStrictEqual(await notifier.raise({ key: "shop", title: "t", body: "b" }), err("ntfy POST https://ntfy.example: 403"));
  strictEqual(world.openAlert("shop"), undefined);
});

test("ntfy: without its token nothing is sent", async () => {
  const { world, sent } = fakeNtfy(200);
  const notifier = ntfy("https://ntfy.example", "alerts", { ...world, token: () => err("no token") });
  deepStrictEqual(await notifier.raise({ key: "shop", title: "t", body: "b" }), err("no token"));
  deepStrictEqual(sent, []);
});
