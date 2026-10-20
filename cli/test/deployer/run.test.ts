import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { field } from "../../src/deployer/app.ts";
import { deploy, type Effects } from "../../src/deployer/runs/run.ts";
import { err, ok } from "../../src/lib/result.ts";
import { commit, shop } from "./support.ts";

const bundle = {
  sha: commit("a"),
  images: [{ variable: "WEB_IMAGE", ref: "localhost:5000/shop/web:0123456789ab" }],
  compose: [{ path: "compose.yml", content: "services: {}\n" }],
  routes: [{ host: "www", service: "web", port: 3000 }],
};

/** What `docker compose config` answers for the bundle's files. */
const config = JSON.stringify({ services: { web: { image: "localhost:5000/shop/web:0123456789ab", networks: { default: null } } } });

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
      return Promise.resolve({ code: step === fail ? 1 : 0, stdout: step === "config" ? config : "" });
    },
    secrets: () => ok({ DATABASE_PASSWORD: "pw" }),
    workdir: () => Promise.resolve("/tmp/run"),
    writeRoutes: (_, content) => {
      const written: unknown = JSON.parse(content);
      const services = typeof written === "object" && written !== null ? field(written, "services") : undefined;
      note(`routes ${typeof services === "object" && services !== null ? Object.keys(services).join(",") : "?"}`);
      return Promise.resolve();
    },
    record: (_, sha, images) => {
      note(`record ${sha.slice(0, 1)} ${images.trim()}`);
      return Promise.resolve();
    },
    status: (_, __, context, state) => {
      note(`${context} ${state}`);
      return Promise.resolve();
    },
    probe: (url) => {
      note(`probe ${url}`);
      return Promise.resolve(200);
    },
    pause: () => Promise.resolve(),
    ...overrides,
  };
  return { fx, did };
};

const site = { appsDir: "/opt/apps", policyScript: "/p/compose-policy.sh", domain: "shop.example.com" };

test("a deploy: build, admission on the resolved config, up, record, readiness, statuses", async () => {
  const { fx, did } = world();
  deepStrictEqual(await deploy(shop, "main", site, fx), { ok: true, sha: commit("a"), urls: ["https://www.shop.example.com/"], checks: [{ url: "https://www.shop.example.com/", status: 200, ok: true }] });
  deepStrictEqual(did, [
    "kayra/build pending",
    "kayra/build success",
    "kayra/deploy pending",
    "config +secrets",
    `policy <${config}`,
    "routes web",
    "up +secrets",
    "record a WEB_IMAGE=localhost:5000/shop/web:0123456789ab",
    "probe https://www.shop.example.com/",
    "kayra/deploy success",
  ]);
});

test("refused by the policy: nothing starts, nothing is recorded", async () => {
  const { fx, did } = world({}, "policy");
  deepStrictEqual(await deploy(shop, "main", site, fx), { ok: false, sha: commit("a"), error: "refused by the compose policy" });
  deepStrictEqual(did.slice(-3), ["config +secrets", `policy <${config}`, "kayra/deploy failure"]);
});

test("a failed build never reaches deploy", async () => {
  const { fx, did } = world({ prepare: () => Promise.resolve(err("buildctl failed")) });
  deepStrictEqual(await deploy(shop, "main", site, fx), { ok: false, sha: commit("a"), error: "build: buildctl failed" });
  deepStrictEqual(did, ["kayra/build pending", "kayra/build failure"]);
});

test("a bundle for another app's images fails the build", async () => {
  const { fx, did } = world({
    prepare: () => Promise.resolve(ok({ ...bundle, images: [{ variable: "WEB_IMAGE", ref: "localhost:5000/other/web:0123456789ab" }] })),
  });
  deepStrictEqual((await deploy(shop, "main", site, fx)).ok, false);
  deepStrictEqual(did, ["kayra/build pending", "kayra/build failure"]);
});

test("an unknown ref: no commit, no status", async () => {
  const { fx, did } = world({ resolve: () => Promise.resolve(err("nope is no branch or tag")) });
  deepStrictEqual(await deploy(shop, "nope", site, fx), { ok: false, error: "nope is no branch or tag" });
  deepStrictEqual(did, []);
});

test("a route to a service the admitted config lacks: no routes written, nothing starts", async () => {
  const { fx, did } = world({ prepare: () => Promise.resolve(ok({ ...bundle, routes: [{ host: "www", service: "api", port: 3000 }] })) });
  deepStrictEqual(await deploy(shop, "main", site, fx), { ok: false, sha: commit("a"), error: "route to api: no such service in the compose files" });
  deepStrictEqual(did.slice(-3), ["config +secrets", `policy <${config}`, "kayra/deploy failure"]);
});

/** A probe answering each URL from a script of statuses, the last one repeating. */
const answering = (script: Readonly<Record<string, readonly number[]>>) => {
  const asked = new Map<string, number>();
  return (url: string) => {
    const times = asked.get(url) ?? 0;
    // eslint-disable-next-line functional/immutable-data -- the fake world's counter
    asked.set(url, times + 1);
    const statuses = script[url] ?? [200];
    return Promise.resolve(statuses[Math.min(times, statuses.length - 1)] ?? 0);
  };
};

test("readiness waits out Traefik's 404 and a backend's 502, then passes", async () => {
  const { fx } = world({ probe: answering({ "https://www.shop.example.com/": [404, 502, 200] }) });
  deepStrictEqual((await deploy(shop, "main", site, fx)).checks, [{ url: "https://www.shop.example.com/", status: 200, ok: true }]);
});

test("without a check path, an app's own 404 counts once Traefik has had time", async () => {
  const { fx } = world({ probe: answering({ "https://www.shop.example.com/": [404] }) });
  deepStrictEqual((await deploy(shop, "main", site, fx)).ok, true);
});

test("a check path must answer 2xx or 3xx; a route that never does fails the run, which still runs and is recorded", async () => {
  const routes = [{ host: "www", service: "web", port: 3000, check: "/healthz" }, { host: "www", path: "/api", service: "web", port: 3000 }];
  const { fx, did } = world({
    prepare: () => Promise.resolve(ok({ ...bundle, routes })),
    probe: answering({ "https://www.shop.example.com/healthz": [404], "https://www.shop.example.com/api": [503] }),
  });
  const outcome = await deploy(shop, "main", site, fx);
  deepStrictEqual(outcome, {
    ok: false,
    sha: commit("a"),
    error: "running, but not ready: https://www.shop.example.com/healthz answered 404; https://www.shop.example.com/api answered 503",
    urls: ["https://www.shop.example.com/"],
    checks: [
      { url: "https://www.shop.example.com/healthz", status: 404, ok: false },
      { url: "https://www.shop.example.com/api", status: 503, ok: false },
    ],
  });
  deepStrictEqual(did.slice(-2), ["record a WEB_IMAGE=localhost:5000/shop/web:0123456789ab", "kayra/deploy failure"]);
});
