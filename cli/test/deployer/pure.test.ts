import { deepStrictEqual, ok as assert, strictEqual } from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { parseApp } from "../../src/deployer/app.ts";
import { parseBundle, imagesEnv } from "../../src/deployer/bundle.ts";
import { config, policy, up } from "../../src/deployer/compose.ts";
import { matches, parseCron } from "../../src/deployer/cron.ts";
import { expired, moved, releaseName, releases } from "../../src/deployer/records.ts";
import { renovate } from "../../src/deployer/run.ts";
import { pushedRef, signed } from "../../src/deployer/webhook.ts";
import { commit, must, name, shop } from "./support.ts";

test("cron: fields, ranges, steps, lists; 7 is Sunday", () => {
  const nightly = must(parseCron("0 3 * * *"));
  assert(matches(nightly, new Date(2026, 9, 17, 3, 0)));
  assert(!matches(nightly, new Date(2026, 9, 17, 3, 1)));
  const weekly = must(parseCron("0 4 * * 7"));
  assert(matches(weekly, new Date(2026, 9, 18, 4, 0)));
  const busy = must(parseCron("*/15 8-18 * * 1-5"));
  assert(matches(busy, new Date(2026, 9, 16, 8, 45)));
  assert(!matches(busy, new Date(2026, 9, 17, 8, 45)));
  deepStrictEqual(parseCron("H 4 * * 1").ok, false);
  deepStrictEqual(parseCron("0 4 * *").ok, false);
  deepStrictEqual(parseCron("60 * * * *").ok, false);
});

test("cron: day of month and weekday both restricted match either", () => {
  const either = must(parseCron("0 0 1 * 1"));
  assert(matches(either, new Date(2026, 9, 1, 0, 0)));
  assert(matches(either, new Date(2026, 9, 5, 0, 0)));
  assert(!matches(either, new Date(2026, 9, 6, 0, 0)));
});

test("webhooks: GitHub's and Forgejo's signatures, nothing unsigned", () => {
  const body = Buffer.from(JSON.stringify({ ref: "refs/heads/main" }));
  const hex = createHmac("sha256", "s3cret").update(body).digest("hex");
  assert(signed("s3cret", body, { "x-hub-signature-256": `sha256=${hex}` }));
  assert(signed("s3cret", body, { "x-forgejo-signature": hex }));
  assert(!signed("other", body, { "x-hub-signature-256": `sha256=${hex}` }));
  assert(!signed("s3cret", body, {}));
  assert(!signed("", body, { "x-forgejo-signature": hex }));
  strictEqual(pushedRef(body), "refs/heads/main");
  strictEqual(pushedRef(Buffer.from("{\"zen\":\"ping\"}")), undefined);
});

test("registrations are checked, not trusted", () => {
  deepStrictEqual(parseApp("shop", { ...shop }), { ok: true, value: shop });
  deepStrictEqual(parseApp("shop", { ...shop, name: "other" }).ok, false);
  deepStrictEqual(parseApp("shop", { ...shop, path: "../x" }).ok, false);
  deepStrictEqual(parseApp("shop", { ...shop, secrets: ["lower"] }).ok, false);
});

test("a bundle may only name the app's own images and relative compose files", () => {
  const good = {
    sha: commit("a"),
    images: [{ variable: "WEB_IMAGE", ref: "localhost:5000/shop/web:0123456789ab" }],
    compose: [{ path: "deploy/compose.yml", content: "services: {}\n" }],
  };
  const bundle = must(parseBundle(name("shop"), commit("a"), good));
  strictEqual(imagesEnv(bundle), "WEB_IMAGE=localhost:5000/shop/web:0123456789ab\n");
  deepStrictEqual(parseBundle(name("shop"), commit("b"), good).ok, false);
  deepStrictEqual(
    parseBundle(name("shop"), commit("a"), { ...good, images: [{ variable: "WEB_IMAGE", ref: "localhost:5000/other/web:0123456789ab" }] }).ok,
    false,
  );
  deepStrictEqual(parseBundle(name("shop"), commit("a"), { ...good, compose: [{ path: "../../etc/x", content: "" }] }).ok, false);
  deepStrictEqual(parseBundle(name("shop"), commit("a"), { ...good, compose: [] }).ok, false);
});

test("compose: admission resolves no env files, up removes orphans", () => {
  const bundle = must(parseBundle(name("shop"), commit("a"), {
    sha: commit("a"),
    images: [],
    compose: [{ path: "compose.yml", content: "" }, { path: "compose.deploy.yml", content: "" }],
  }));
  const project = ["docker", "compose", "-p", "shop", "--project-directory", "/opt/apps/shop", "--env-file", "/opt/apps/shop/.env",
    "--env-file", "images.env", "-f", "compose.yml", "-f", "compose.deploy.yml"];
  deepStrictEqual(config(shop, "/opt/apps", bundle), [...project, "config", "--no-env-resolution", "--format", "json"]);
  deepStrictEqual(up(shop, "/opt/apps", bundle), [...project, "up", "-d", "--wait", "--wait-timeout", "180", "--remove-orphans"]);
  deepStrictEqual(policy(shop, "/p/compose-policy.sh"), ["bash", "/p/compose-policy.sh", "shop", "www.shop.example.com"]);
});

test("releases: newest first, one per commit; retention drops the oldest", () => {
  const names = [
    releaseName(new Date("2026-10-01T10:00:00Z"), commit("a")),
    releaseName(new Date("2026-10-02T10:00:00Z"), commit("b")),
    releaseName(new Date("2026-10-03T10:00:00Z"), commit("a")),
    "junk",
  ];
  deepStrictEqual(names[0], `20261001T100000Z-${commit("a")}.env`);
  deepStrictEqual(releases(names), [
    { sha: commit("a"), time: "20261003T100000Z" },
    { sha: commit("b"), time: "20261002T100000Z" },
  ]);
  deepStrictEqual(expired(["3", "1", "2"], 2), ["1"]);
  deepStrictEqual(expired(["1"], 2), []);
});

test("poll: only a commit neither the newest run nor the newest release has", () => {
  assert(moved(commit("c"), commit("a"), commit("b")));
  assert(moved(commit("c"), undefined, undefined));
  assert(!moved(commit("a"), commit("a"), commit("b")));
  assert(!moved(commit("b"), undefined, commit("b")));
  assert(!moved(commit("b"), commit("a"), commit("b")));
});

test("renovate: the optional settings only when set", () => {
  const argv = renovate({ RENOVATE_ENDPOINT: "http://forgejo:3000/api/v1", RENOVATE_GIT_URL: "" }, true, "renovate/renovate:1");
  assert(argv.includes("RENOVATE_ENDPOINT"));
  assert(!argv.includes("RENOVATE_GIT_URL"));
  assert(argv.includes("RENOVATE_DRY_RUN=full"));
  strictEqual(argv.at(-1), "renovate/renovate:1");
});
