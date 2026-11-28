import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { runMaintenance } from "../../src/server/platform/maintenance.ts";

const settings = { platformDir: "/platform", gcScript: "/gc", renovateImage: "renovate:pinned", env: {} };

test("platform maintenance invokes GC without reading a token", async () => {
  const result = await runMaintenance({ job: "gc", dryRun: false }, settings, {
    token: () => { throw new Error("GC should not need a token"); },
    exec: (argv, options) => {
      deepStrictEqual(argv, ["bash", "/gc"]);
      deepStrictEqual(options, { cwd: "/platform", env: {} });
      return Promise.resolve({ code: 0 });
    },
  });
  deepStrictEqual(result, { ok: true });
});

test("a GC dry run fails without executing a command or reading a token", async () => {
  const result = await runMaintenance({ job: "gc", dryRun: true }, settings, {
    token: () => { throw new Error("GC dry run must not read a token"); },
    exec: () => { throw new Error("GC dry run must not execute a command"); },
  });
  deepStrictEqual(result, { ok: false, error: "Registry GC does not support dry runs; no cleanup was performed." });
});

test("platform maintenance supplies Renovate's token and reports failure", async () => {
  const result = await runMaintenance({ job: "renovate", dryRun: true }, settings, {
    token: (name) => name === "RENOVATE_TOKEN" ? "secret" : "",
    exec: (argv, options) => {
      deepStrictEqual(argv.slice(-5), ["-e", "RENOVATE_DRY_RUN=full", "-e", "LOG_LEVEL=info", "renovate:pinned"]);
      deepStrictEqual(options, { cwd: "/platform", env: { RENOVATE_TOKEN: "secret" } });
      return Promise.resolve({ code: 1 });
    },
  });
  deepStrictEqual(result, { ok: false });
});
