import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appName } from "../../src/deployer/brand.ts";
import { acquireComposeAppLease } from "../../src/server/runtime/compose-app-lease.ts";

test("the deployer contends on the same app lock as a host lifecycle command", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kayra-app-lease-"));
  try {
    const app = appName("shop");
    assert.ok(app.ok);
    const path = join(root, "shop.lock");
    assert.throws(() => acquireComposeAppLease(root, app.value), { code: "ENOENT" });
    await symlink("other.lock", path);
    assert.throws(() => acquireComposeAppLease(root, app.value), { code: "ELOOP" });
    await rm(path);
    await writeFile(path, "", { mode: 0o444 });

    const lease = acquireComposeAppLease(root, app.value);
    assert.ok(lease);
    try {
      assert.equal(spawnSync("flock", ["-n", "-E", "75", path, "true"]).status, 75);
      assert.equal(acquireComposeAppLease(root, app.value), undefined);
    } finally {
      lease.close();
    }
    assert.equal(spawnSync("flock", ["-n", path, "true"]).status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
