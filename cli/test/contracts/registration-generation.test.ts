import { strict as assert } from "node:assert";
import { test } from "node:test";
import { matchRegistrationGeneration, parseRegistrationGeneration, parseRegistrationObservation } from "../../src/contracts/registration-generation.ts";

const incarnation = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const metadata = { version: 1, app: "shop-", incarnation, actionId: `${incarnation}:1`, registrationGeneration: other };

test("observations share metadata identity validation without accepting extra fields", () => {
  const identity = { app: metadata.app, incarnation: metadata.incarnation, actionId: metadata.actionId, registrationGeneration: metadata.registrationGeneration };
  for (const status of ["applied", "not-applied", "unknown"]) {
    assert.equal(parseRegistrationObservation({ ...identity, status }).ok, true);
  }
  for (const observation of [{ ...identity, status: "success" }, { ...identity, status: "applied", secret: "value" }, { ...identity, status: "applied", actionId: `${other}:1` }]) {
    assert.equal(parseRegistrationObservation(observation).ok, false);
  }
  const getter = Object.defineProperty({ ...identity, status: "applied" }, "status", { get: () => { throw new Error("must not invoke"); } });
  assert.equal(parseRegistrationObservation(getter).ok, false);
});

test("validates and snapshots the common manifest and pointer shape", () => {
  const value = parseRegistrationGeneration(metadata);
  assert.equal(value.ok, true);
  assert.deepEqual(value.value, metadata);
  assert.equal(Object.isFrozen(value.value), true);
  assert.notEqual(value.value, metadata);
  assert.equal(matchRegistrationGeneration(metadata, { ...metadata }, { ...metadata }).ok, true);
});

test("rejects identity changes between manifest, pointer and expected intent", () => {
  const changes = [
    { ...metadata, app: "other" },
    { ...metadata, incarnation: other, actionId: `${other}:1` },
    { ...metadata, actionId: `${incarnation}:2` },
    { ...metadata, registrationGeneration: incarnation },
  ];
  changes.forEach((changed) => {
    assert.equal(matchRegistrationGeneration(metadata, changed, metadata).ok, false);
    assert.equal(matchRegistrationGeneration(metadata, metadata, changed).ok, false);
  });
});

test("requires the existing app-name rule and a canonical action of the same incarnation", () => {
  const badActions = [`${other}:1`, `${incarnation}:0`, `${incarnation}:01`, `${incarnation}:-1`, `${incarnation}:1.0`, `${incarnation}:${String(Number.MAX_SAFE_INTEGER)}`, `${incarnation}:999999999999999999999`, "bad:1"];
  badActions.forEach((actionId) => { assert.equal(parseRegistrationGeneration({ ...metadata, actionId }).ok, false); });
  assert.equal(parseRegistrationGeneration({ ...metadata, actionId: `${incarnation}:${String(Number.MAX_SAFE_INTEGER - 1)}` }).ok, true);
  ["", "../shop", "Shop", "_job", "shop/name"].forEach((app) => { assert.equal(parseRegistrationGeneration({ ...metadata, app }).ok, false); });
});

test("rejects malformed, extra and secret-bearing fields", () => {
  [null, {}, { ...metadata, version: 2 }, { ...metadata, incarnation: "bad" }, { ...metadata, registrationGeneration: "bad" }, { ...metadata, secret: "plaintext" }].forEach((value) => {
    assert.equal(parseRegistrationGeneration(value).ok, false);
    assert.equal(matchRegistrationGeneration(value, metadata, metadata).ok, false);
  });
});

test("rejects inherited fields and accessors without invoking getters", () => {
  const inheritedField: unknown = Object.setPrototypeOf({
    version: metadata.version, incarnation: metadata.incarnation, actionId: metadata.actionId, registrationGeneration: metadata.registrationGeneration,
  }, { app: metadata.app });
  assert.equal(parseRegistrationGeneration(inheritedField).ok, false);
  const throwing: unknown = Object.defineProperty({ ...metadata }, "app", { enumerable: true, get: () => { throw new Error("must not run"); } });
  assert.equal(parseRegistrationGeneration(throwing).ok, false);
  const proxy: unknown = new Proxy({}, { getPrototypeOf: () => { throw new Error("unavailable"); } });
  assert.equal(parseRegistrationGeneration(proxy).ok, false);
  const nullPrototype: unknown = Object.setPrototypeOf({ ...metadata }, null);
  assert.equal(parseRegistrationGeneration(nullPrototype).ok, true);
});
