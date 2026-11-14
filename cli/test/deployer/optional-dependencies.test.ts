import { strict as assert } from "node:assert";
import { cp, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("normal server entrypoint and ctl load without experimental image dependencies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kayra-no-dependencies-")); t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL("../../src/", import.meta.url), root, { recursive: true }); await writeFile(join(root, "package.json"), '{"type":"module"}');
  const run = (...args: readonly string[]) => spawnSync(process.execPath, [join(root, "deployer/main.ts"), ...args], { encoding: "utf8", cwd: root, env: { ...process.env, NODE_PATH: "" }, timeout: 15000 });
  const entry = run(); assert.equal(entry.status, 2, entry.stderr); assert.match(entry.stderr, /usage: main.ts builder/); assert.doesNotMatch(entry.stderr, /ERR_MODULE_NOT_FOUND/);
  const ctl = run("ctl", "runs", "shop", "--json"); assert.equal(ctl.status, 0, ctl.stderr); assert.deepEqual(JSON.parse(ctl.stdout), { app: "shop", runs: [] });
  const request = Buffer.from(JSON.stringify({ app: "shop", run: "11111111-1111-4111-8111-111111111111", step: "schema" })).toString("base64url");
  const optional = run("ctl", "migration", "audit", request); assert.equal(optional.status, 1, optional.stderr); assert.match(optional.stderr, /optional contract dependencies are not installed/); assert.doesNotMatch(optional.stderr, /ERR_MODULE_NOT_FOUND/);
});
