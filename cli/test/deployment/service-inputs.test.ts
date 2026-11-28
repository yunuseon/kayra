/* eslint-disable functional/no-let -- local read counters prove invalid requests never open private snapshots */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseServiceInputs } from "../../src/contracts/service-inputs.ts";
import { serviceInputValues, platformServiceInputs } from "../../src/server/platform/service-inputs.ts";

const incarnation = "11111111-1111-4111-8111-111111111111";
const oldGeneration = "22222222-2222-4222-8222-222222222222";
const newGeneration = "33333333-3333-4333-8333-333333333333";
const inputs = (generation: string, configuration: string, environment: unknown = { DB_PASSWORD: { kind: "secret", key: "PASSWORD" }, DB_NAME: { kind: "configuration", key: "DATABASE" } }) => {
  const checked = parseServiceInputs({ version: 1, registration: { version: 1, app: "shop", incarnation, actionId: `${incarnation}:1`, registrationGeneration: generation }, configurationIdentity: "sha256:" + configuration.repeat(64), environment });
  assert.ok(checked.ok); return checked.value;
};
const before = inputs(oldGeneration, "a"); const after = inputs(newGeneration, "b");
const snapshot = (identity: string, configuration: Readonly<Record<string, string>>, secrets: Readonly<Record<string, string>>) =>
  Object.freeze({ configurationIdentity: identity, configuration, secrets, secretKeys: Object.freeze(["PASSWORD", "UNUSED_TOKEN"]) });
const previous = snapshot(before.configurationIdentity, { DATABASE: "database", THEME: "dark" }, { PASSWORD: "private-password", UNUSED_TOKEN: "private-token" });
const candidate = snapshot(after.configurationIdentity, { DATABASE: "database", THEME: "light" }, { PASSWORD: "private-password", UNUSED_TOKEN: "rotated-unused-token" });
const reader = (next = candidate) => serviceInputValues((reference) => Promise.resolve(reference.registration.registrationGeneration === oldGeneration ? previous : next));

test("retained dependency comparison ignores unrelated configuration and secret rotation across exact generations", async () => {
  const port = reader(); assert.equal(await port.compare(before, after), "unchanged");
  const values = await port.materialize(before); assert.ok(values.ok); assert.deepEqual(values.value, { DB_PASSWORD: "private-password", DB_NAME: "database" }); assert.ok(Object.isFrozen(values.value));
  assert.ok(Object.isFrozen(before.environment)); assert.ok(Object.isFrozen(before.environment["DB_PASSWORD"]));
});

test("a changed used secret or configuration binding is reported without exposing either value", async () => {
  for (const next of [snapshot(after.configurationIdentity, { DATABASE: "changed-database" }, candidate.secrets), snapshot(after.configurationIdentity, candidate.configuration, { PASSWORD: "rotated-password" })]) {
    const result = await reader(next).compare(before, after); assert.equal(result, "changed"); assert.equal(JSON.stringify(result).includes("password"), false);
  }
  const rebound = inputs(newGeneration, "b", { DB_PASSWORD: { kind: "secret", key: "UNUSED_TOKEN" }, DB_NAME: { kind: "configuration", key: "DATABASE" } });
  assert.equal(await reader().compare(before, rebound), "changed");
});

test("comparison checks binding identities and literal changes while ignoring environment key order", async () => {
  const literal = inputs(oldGeneration, "a", { A: { kind: "literal", value: "one" }, B: { kind: "literal", value: "two" } });
  const reordered = inputs(newGeneration, "b", { B: { kind: "literal", value: "two" }, A: { kind: "literal", value: "one" } });
  assert.equal(await reader().compare(literal, reordered), "unchanged");
  assert.equal(await reader().compare(literal, inputs(newGeneration, "b", { A: { kind: "literal", value: "changed" }, B: { kind: "literal", value: "two" } })), "changed");
  assert.equal(await reader().compare(literal, inputs(newGeneration, "b", { A: { kind: "literal", value: "one" } })), "changed");
});

test("missing, stale or failed snapshots produce unavailable and never leak private errors", async () => {
  for (const port of [serviceInputValues(() => Promise.resolve(undefined)), serviceInputValues(() => Promise.reject(new Error("private-password in failure"))), reader(snapshot("sha256:" + "c".repeat(64), candidate.configuration, candidate.secrets)), reader(snapshot(after.configurationIdentity, {}, candidate.secrets)), reader(snapshot(after.configurationIdentity, candidate.configuration, {}))]) {
    assert.equal(await port.compare(before, after), "unavailable");
    const value = await port.materialize(after); assert.equal(value.ok, false); assert.equal(value.error, "service inputs are unavailable");
  }
});

test("cross-app and cross-incarnation comparison refuses before opening snapshots", async () => {
  let reads = 0; const port = serviceInputValues(() => { reads++; return Promise.resolve(previous); });
  for (const registration of [{ ...after.registration, app: "other" }, { ...after.registration, incarnation: oldGeneration, actionId: `${oldGeneration}:1` }]) {
    const checked = parseServiceInputs({ ...after, registration }); assert.ok(checked.ok); assert.equal(await port.compare(before, checked.value), "unavailable");
  }
  assert.equal(reads, 0);
});

test("undeclared secret access, category collisions and invalid private values are unavailable", async () => {
  const undeclared = inputs(newGeneration, "b", { TOKEN: { kind: "secret", key: "HIDDEN" } });
  const hidden = serviceInputValues(() => Promise.resolve({ ...candidate, secrets: { ...candidate.secrets, HIDDEN: "hidden-private" } }));
  assert.equal((await hidden.materialize(undeclared)).ok, false);
  for (const next of [{ ...candidate, configuration: { ...candidate.configuration, PASSWORD: "collision" } }, { ...candidate, secrets: { PASSWORD: "bad\0value" } }, { ...candidate, secrets: { PASSWORD: "x".repeat(65537) } }]) assert.equal(await reader(next).compare(before, after), "unavailable");
});

test("input references are bounded, immutable and reject extra fields or malformed bindings before reads", async () => {
  for (const input of [{ ...before, configurationIdentity: "moving" }, { ...before, secretValues: { PASSWORD: "private" } }, { ...before, environment: { PASSWORD: { kind: "secret", key: "PASSWORD", value: "private" } } }, { ...before, environment: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`K${String(index)}`, { kind: "literal", value: "" }])) }]) assert.equal(parseServiceInputs(input).ok, false);
  const invalid = { ...before, configurationIdentity: "moving" }; let reads = 0;
  const port = serviceInputValues(() => { reads++; return Promise.resolve(previous); });
  assert.equal((await port.materialize(invalid)).ok, false); assert.equal(reads, 0);
});

test("real platform reader reports absent registration generations without private details", async () => {
  const port = platformServiceInputs("/nonexistent-kayra-inputs-public", "/nonexistent-kayra-inputs-private", 1000);
  assert.equal(await port.compare(before, after), "unavailable"); assert.deepEqual(await port.materialize(before), { ok: false, error: "service inputs are unavailable" });
});
