import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseMigrationPolicy } from "../../src/contracts/migration-policy.ts";

const policy = { version: 1, migrationTimeoutCeilingSeconds: 90 };
test("host migration policy requires a bounded integral ceiling without app effects or deadlines", () => {
  for (const ceiling of [1, 90, 86400]) {
    const result = parseMigrationPolicy({ ...policy, migrationTimeoutCeilingSeconds: ceiling }); assert.ok(result.ok);
    assert.equal(result.value.migrationTimeoutCeilingSeconds, ceiling); assert.ok(Object.isFrozen(result.value));
  }
  for (const ceiling of [0, -1, 1.1, 86401, Infinity, NaN, "90", null, true]) assert.equal(parseMigrationPolicy({ ...policy, migrationTimeoutCeilingSeconds: ceiling }).ok, false);
  for (const input of [null, [], {}, { version: 1 }, { ...policy, version: 2 }, { ...policy, deadline: 100 }, { ...policy, command: ["sql"] }, { ...policy, enabled: true }]) assert.equal(parseMigrationPolicy(input).ok, false);
});
