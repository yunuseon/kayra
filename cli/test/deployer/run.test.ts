import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { deploy, type Effects } from "../../src/deployer/runs/run.ts";
import { err, ok } from "../../src/result.ts";
import { commit, shop } from "./support.ts";

const bundle = {
  sha: commit("a"),
  images: [{ variable: "WEB_IMAGE", ref: "localhost:5000/shop/web:0123456789ab" }],
  compose: [{ path: "compose.yml", content: "services: {}\n" }],
};

/** A world that records what the run did; `fail` names the step that exits non-zero. */
const world = (overrides: Partial<Effects> = {}, fail?: string): { readonly fx: Effects; readonly did: readonly string[] } => {
  // eslint-disable-next-line functional/prefer-immutable-types -- the fake world's recorder
  const did: string[] = [];
  const note = (entry: string): void => {
    // eslint-disable-next-line functional/immutable-data -- the fake world's recorder
    did.push(entry);
  };
  const fx: Effects = {
    log: () => undefined,
    resolve: () => Promise.resolve(ok(commit("a"))),
    prepare: () => Promise.resolve(ok(bundle)),
    exec: (argv, options) => {
      const step = argv.includes("config") ? "config" : argv.includes("up") ? "up" : "policy";
      note(`${step}${Object.keys(options.env).length > 0 ? " +secrets" : ""}${options.stdin === undefined ? "" : ` <${options.stdin}`}`);
      return Promise.resolve({ code: step === fail ? 1 : 0, stdout: step === "config" ? "{config}" : "" });
    },
    secrets: () => ok({ DATABASE_PASSWORD: "pw" }),
    workdir: () => Promise.resolve("/tmp/run"),
    record: (_, sha, images) => {
      note(`record ${sha.slice(0, 1)} ${images.trim()}`);
      return Promise.resolve();
    },
    status: (_, __, context, state) => {
      note(`${context} ${state}`);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { fx, did };
};

const paths = { appsDir: "/opt/apps", policyScript: "/p/compose-policy.sh" };

test("a deploy: build, admission on the resolved config, up, record, statuses", async () => {
  const { fx, did } = world();
  deepStrictEqual(await deploy(shop, "main", paths, fx), { ok: true, sha: commit("a") });
  deepStrictEqual(did, [
    "kayra/build pending",
    "kayra/build success",
    "kayra/deploy pending",
    "config +secrets",
    "policy <{config}",
    "up +secrets",
    "record a WEB_IMAGE=localhost:5000/shop/web:0123456789ab",
    "kayra/deploy success",
  ]);
});

test("refused by the policy: nothing starts, nothing is recorded", async () => {
  const { fx, did } = world({}, "policy");
  deepStrictEqual(await deploy(shop, "main", paths, fx), { ok: false, sha: commit("a") });
  deepStrictEqual(did.slice(-3), ["config +secrets", "policy <{config}", "kayra/deploy failure"]);
});

test("a failed build never reaches deploy", async () => {
  const { fx, did } = world({ prepare: () => Promise.resolve(err("buildctl failed")) });
  deepStrictEqual(await deploy(shop, "main", paths, fx), { ok: false, sha: commit("a") });
  deepStrictEqual(did, ["kayra/build pending", "kayra/build failure"]);
});

test("a bundle for another app's images fails the build", async () => {
  const { fx, did } = world({
    prepare: () => Promise.resolve(ok({ ...bundle, images: [{ variable: "WEB_IMAGE", ref: "localhost:5000/other/web:0123456789ab" }] })),
  });
  deepStrictEqual((await deploy(shop, "main", paths, fx)).ok, false);
  deepStrictEqual(did, ["kayra/build pending", "kayra/build failure"]);
});

test("an unknown ref: no commit, no status", async () => {
  const { fx, did } = world({ resolve: () => Promise.resolve(err("nope is no branch or tag")) });
  deepStrictEqual(await deploy(shop, "nope", paths, fx), { ok: false });
  deepStrictEqual(did, []);
});
