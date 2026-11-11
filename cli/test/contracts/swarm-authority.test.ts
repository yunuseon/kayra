import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseApp, parseIndexedApp } from "../../src/contracts/app-registration.ts";
import { parseSwarmAuthority, parseSwarmGrants, admitSwarmGrants } from "../../src/contracts/swarm-authority.ts";
import { shop } from "../deployer/support.ts";

const fixture: unknown = JSON.parse(readFileSync(new URL("../../../ci/tests/swarm-host/authority.json", import.meta.url), "utf8"));
const parsed = parseSwarmAuthority(fixture);
assert.ok(parsed.ok);
const authority = parsed.value;
const grants = { memory_bytes: 256 * 1024**2, cpu_millicores: 500, maintenance: false };

test("Swarm authority and grants require explicit validated immutable budgets", () => {
  assert.ok(Object.isFrozen(authority.profile));
  assert.ok(Object.isFrozen(authority.network));
  assert.deepEqual(authority, fixture);
  for (const value of [null, {}, { ...authority, version: true }, { ...authority, node: "bad" }, { ...authority, network: { ...authority.network, name: "platform-public" } }, { ...authority, profile: { ...authority.profile, enabled: false } }, { ...authority, profile: { ...authority.profile, advertise_address: "192.000.2.1" } }, { ...authority, profile: { ...authority.profile, platform_memory_bytes: authority.profile.memory_bytes } }]) {
    assert.equal(parseSwarmAuthority(value).ok, false);
  }
  const checked = parseSwarmGrants(grants);
  assert.ok(checked.ok);
  assert.ok(admitSwarmGrants(authority, checked.value).ok);
  assert.equal(admitSwarmGrants(authority, { ...checked.value, memory_bytes: authority.profile.memory_bytes }).ok, false);
  assert.equal(admitSwarmGrants(authority, { ...checked.value, cpu_millicores: authority.profile.cpu_millicores }).ok, false);
  for (const value of [{}, { ...grants, maintenance: undefined }, { ...grants, cpu_millicores: 0 }, { ...grants, memory_bytes: true }, { ...grants, extra: "ignored" }]) assert.equal(parseSwarmGrants(value).ok, false);
});

test("indexed Swarm registrations cannot leak into the legacy Compose reader", () => {
  const registration = { ...shop, runtime: "swarm", grants };
  const checked = parseIndexedApp("shop", registration);
  assert.ok(checked.ok);
  assert.equal(checked.value.runtime, "swarm");
  assert.equal(parseApp("shop", registration).ok, false);
  assert.equal(parseIndexedApp("shop", { ...shop, runtime: undefined }).ok, false);
  assert.equal(parseIndexedApp("shop", { ...registration, grants: undefined }).ok, false);
  assert.equal(parseIndexedApp("bad-", { ...registration, name: "bad-" }).ok, false);
  assert.equal(parseIndexedApp("a".repeat(49), { ...registration, name: "a".repeat(49) }).ok, false);
  assert.ok(Object.isFrozen(checked.value.hosts));
});
