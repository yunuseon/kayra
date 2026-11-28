import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, chmod, rename, link, symlink, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readMigrationPolicy } from "../../src/server/platform/migration-policy.ts";

const linuxRoot = process.platform === "linux" && process.getuid?.() === 0;
test("platform policy reader enforces ownership, mode and bounded content across atomic replacement", { skip: !linuxRoot }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kayra-migration-policy-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "migration.json"); const next = join(root, "next.json");
  const publish = async (ceiling: number) => { await writeFile(next, JSON.stringify({ version: 1, migrationTimeoutCeilingSeconds: ceiling }), { mode: 0o444 }); await rename(next, path); };
  assert.equal((await readMigrationPolicy(path)).ok, false);
  await publish(90); const before = await readMigrationPolicy(path); assert.ok(before.ok); await publish(300);
  const after = await readMigrationPolicy(path); assert.ok(after.ok); assert.equal(after.value.migrationTimeoutCeilingSeconds, 300); assert.equal(before.value.migrationTimeoutCeilingSeconds, 90);
  await chmod(path, 0o644); assert.equal((await readMigrationPolicy(path)).ok, false); await chmod(path, 0o444);
  await link(path, next); assert.equal((await readMigrationPolicy(path)).ok, false); await unlink(next);
  await rename(path, next); await symlink(next, path); assert.equal((await readMigrationPolicy(path)).ok, false); await unlink(path); await unlink(next);
  await publish(86401); assert.equal((await readMigrationPolicy(path)).ok, false);
});
