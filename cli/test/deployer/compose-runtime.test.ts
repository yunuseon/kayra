import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { composeProjectRunning, composeRuntime } from "../../src/server/runtime/compose.ts";

const request = {
  app: { name: "shop" },
  appsDir: "/opt/apps",
  bundle: { compose: [{ path: "compose.yml" }, { path: "compose.prod.yml" }] },
  cwd: "/tmp/run",
  env: { DATABASE_PASSWORD: "secret" },
};
const project = ["docker", "compose", "-p", "shop", "--project-directory", "/opt/apps/shop", "--env-file", "/opt/apps/shop/.env", "--env-file", "images.env", "-f", "app/compose.yml", "-f", "app/compose.prod.yml"];

test("Compose adapter renders and captures the admitted configuration", async () => {
  const runtime = composeRuntime((argv, options) => {
    deepStrictEqual(argv, [...project, "config", "--no-env-resolution", "--format", "json"]);
    deepStrictEqual(options, { cwd: "/tmp/run", env: { DATABASE_PASSWORD: "secret" }, capture: true });
    return Promise.resolve({ code: 0, stdout: "config" });
  });
  deepStrictEqual(await runtime.config(request), { code: 0, stdout: "config" });
});

test("Compose adapter starts the same app files with platform routes", async () => {
  const runtime = composeRuntime((argv, options) => {
    deepStrictEqual(argv, [...project, "-f", "routes.yml", "up", "-d", "--wait", "--wait-timeout", "180", "--remove-orphans"]);
    deepStrictEqual(options, { cwd: "/tmp/run", env: { DATABASE_PASSWORD: "secret" } });
    return Promise.resolve({ code: 1, stdout: "failed" });
  });
  deepStrictEqual(await runtime.up(request), { code: 1, stdout: "failed" });
});

test("Compose restart observation treats running and restarting containers as present", async () => {
  const result = await composeProjectRunning(request.app, (argv, options) => {
    deepStrictEqual(argv, ["docker", "ps", "-q", "--filter", "label=com.docker.compose.project=shop", "--filter", "status=running", "--filter", "status=restarting"]);
    deepStrictEqual(options, { cwd: "/", env: {}, capture: true, timeoutMs: 30_000 });
    return Promise.resolve({ code: 0, stdout: "container-id\n" });
  });
  strictEqual(result, true);
});

test("Compose restart observation restores only after a successful empty result", async () => {
  strictEqual(await composeProjectRunning(request.app, () => Promise.resolve({ code: 0, stdout: " \n" })), false);
  strictEqual(await composeProjectRunning(request.app, () => Promise.resolve({ code: 1, stdout: "" })), true);
});
