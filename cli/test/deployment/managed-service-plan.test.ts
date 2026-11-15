import { strict as assert } from "node:assert";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { managedServiceName, managedServiceDigest, parseManagedServicePlan } from "../../src/contracts/managed-service-plan.ts";
import { ownedVolume } from "../../src/contracts/owned-volume.ts";
import { retainService } from "../../src/server/deployment/retained-service.ts";
import { serviceInputValues } from "../../src/server/platform/service-inputs.ts";

const owner = { version: 1, app: "shop", incarnation: randomUUID(), dataOwner: randomUUID() } as const;
const volume = ownedVolume(owner.app, owner.dataOwner, randomUUID(), "database"); assert.ok(volume.ok);
const registration = { version: 1, app: "shop", incarnation: owner.incarnation, actionId: `${owner.incarnation}:1`, registrationGeneration: randomUUID() } as const;
const declaration = {
  version: 1, runtime: "swarm", owner, service: "db", nativeName: managedServiceName(owner, "db"), role: "retained-dependency", overlap: "forbidden", handoffCheck: null,
  image: "localhost:5000/shop/database@sha256:" + "a".repeat(64),
  inputs: { version: 1, registration, configurationIdentity: "sha256:" + "b".repeat(64), environment: { PASSWORD: { kind: "secret", key: "DATABASE_PASSWORD" } } },
  command: null, entrypoint: null, resources: { memoryBytes: 134217728, reserveMemoryBytes: 67108864, nanoCpus: 250000000, reserveNanoCpus: 125000000 },
  health: { command: ["/health"], intervalSeconds: 2, timeoutSeconds: 1, startPeriodSeconds: 20, retries: 2 }, stopGraceSeconds: 30,
  host: { node: "a".repeat(25), cluster: "b".repeat(25), routingNetwork: null }, privateNetwork: { id: "d".repeat(25), name: `kayra-app-${owner.incarnation}` },
  mounts: [{ volume: volume.value, createdAt: "2026-11-14T20:00:00Z", target: "/var/lib/database", readOnly: false, noCopy: true }], dependencies: [],
};
const checked = parseManagedServicePlan(declaration); assert.ok(checked.ok); const previous = checked.value;
const next = (replacement: Readonly<Record<string, unknown>>) => { const parsed = parseManagedServicePlan({ ...declaration, ...replacement }); assert.ok(parsed.ok); return parsed.value; };

test("managed service plan binds exact owner, incarnation, input generation, image and volume receipt", () => {
  assert.ok(Object.isFrozen(previous)); assert.ok(Object.isFrozen(previous.mounts)); assert.ok(Object.isFrozen(previous.health.command)); assert.ok(Object.isFrozen(previous.inputs.environment));
  assert.match(managedServiceDigest(previous), /^[a-f0-9]{64}$/); assert.equal(managedServiceDigest(previous), managedServiceDigest(next({})));
  assert.ok(previous.nativeName.length <= 63); assert.notEqual(previous.nativeName, managedServiceName({ ...owner, incarnation: randomUUID() }, "db"));
  assert.notEqual(previous.nativeName, managedServiceName(owner, "worker"));
});

test("managed runtime plan rejects foreign ownership, floating images, unsupported fields and contradictory roles", () => {
  for (const changed of [
    { image: "localhost:5000/other/database@sha256:" + "a".repeat(64) }, { image: "localhost:5000/shop/database:latest" }, { resolvedSecrets: { PASSWORD: "private" } },
    { nativeName: "existing-workload" }, { privateNetwork: { ...declaration.privateNetwork, name: "platform-swarm" } }, { role: "http", overlap: "allowed", host: { ...declaration.host, routingNetwork: declaration.privateNetwork.id } },
    { inputs: { ...declaration.inputs, registration: { ...registration, app: "other" } } }, { overlap: "allowed" }, { overlap: "coordinated" }, { handoffCheck: "fake-check" },
    { resources: { ...declaration.resources, reserveMemoryBytes: 268435456 } }, { health: { ...declaration.health, timeoutSeconds: 3 } },
    { mounts: [{ ...declaration.mounts[0], createdAt: "not-a-receipt" }] }, { mounts: [{ ...declaration.mounts[0], target: "/host/../data" }] },
  ]) assert.equal(parseManagedServicePlan({ ...declaration, ...changed }).ok, false, JSON.stringify(changed));
});

test("volume references must match the app/data owner and cannot conflict or overlap", () => {
  const foreign = ownedVolume("other", randomUUID(), randomUUID(), "database"); const replaced = ownedVolume("shop", owner.dataOwner, randomUUID(), "database"); assert.ok(foreign.ok && replaced.ok);
  for (const mounts of [
    [{ ...declaration.mounts[0], volume: foreign.value }], [declaration.mounts[0], { ...declaration.mounts[0], target: "/var/lib/database/nested" }],
    [declaration.mounts[0], { ...declaration.mounts[0], target: "/other", volume: replaced.value }],
    [declaration.mounts[0], { ...declaration.mounts[0], target: "/other", createdAt: "2026-11-14T21:00:00Z" }],
    [declaration.mounts[0], { ...declaration.mounts[0], target: "/other", volume: { ...volume.value, key: "other" } }],
  ]) assert.equal(parseManagedServicePlan({ ...declaration, mounts }).ok, false);
});

test("coordinated singleton declaration requires a handoff reference and forbidden-overlap workers remain representable", () => {
  assert.equal(parseManagedServicePlan({ ...declaration, role: "singleton", overlap: "coordinated" }).ok, false);
  assert.equal(parseManagedServicePlan({ ...declaration, role: "singleton", overlap: "coordinated", handoffCheck: "handoff" }).ok, true);
  assert.equal(parseManagedServicePlan({ ...declaration, role: "singleton", overlap: "allowed" }).ok, false);
  assert.equal(parseManagedServicePlan({ ...declaration, role: "worker", overlap: "forbidden" }).ok, true);
});

test("canonical description order does not change the immutable digest and invalid dependency arrays fail", () => {
  const one = next({ inputs: { ...declaration.inputs, environment: { Z: { kind: "literal", value: "z" }, A: { kind: "literal", value: "a" } } }, dependencies: [{ service: "queue", condition: "healthy" }, { service: "cache", condition: "started" }] });
  const two = next({ inputs: { ...declaration.inputs, environment: { A: { kind: "literal", value: "a" }, Z: { kind: "literal", value: "z" } } }, dependencies: [{ service: "cache", condition: "started" }, { service: "queue", condition: "healthy" }] });
  assert.equal(managedServiceDigest(one), managedServiceDigest(two));
  for (const dependencies of [[{ service: "db", condition: "started" }], [{ service: "queue", condition: "healthy" }, { service: "queue", condition: "started" }], Array(1)]) assert.equal(parseManagedServicePlan({ ...declaration, dependencies }).ok, false);
});

test("retained reconciliation carries the previous generation when bound values are unchanged", async () => {
  const candidate = next({ inputs: { ...declaration.inputs, registration: { ...registration, registrationGeneration: randomUUID() }, configurationIdentity: "sha256:" + "c".repeat(64) } });
  const inputs = serviceInputValues((reference) => Promise.resolve({ configurationIdentity: reference.configurationIdentity, configuration: { UNUSED: reference.configurationIdentity }, secrets: { DATABASE_PASSWORD: "synthetic-private" }, secretKeys: ["DATABASE_PASSWORD"] }));
  const retained = await retainService(previous, candidate, { compare: inputs.compare }); assert.ok(retained.ok);
  assert.deepEqual(retained.value, previous); assert.notEqual(retained.value.inputs.registration.registrationGeneration, candidate.inputs.registration.registrationGeneration);
  assert.equal(JSON.stringify(retained.value).includes("synthetic-private"), false);
});

test("ordinary retained reconciliation refuses changed engine/specification/volume and unavailable or changed inputs", async () => {
  for (const candidate of [next({ image: "localhost:5000/shop/database@sha256:" + "d".repeat(64) }), next({ resources: { ...declaration.resources, memoryBytes: 268435456 } }), next({ stopGraceSeconds: 20 }), next({ command: ["/different"] }), next({ mounts: [] }), next({ dependencies: [{ service: "queue", condition: "started" }] })]) {
    const retained = await retainService(previous, candidate, { compare: () => Promise.reject(new Error("must not read changed specifications")) }); assert.equal(retained.ok, false); assert.match(retained.error, /specification changed/);
  }
  for (const comparison of ["changed", "unavailable"] as const) {
    const retained = await retainService(previous, previous, { compare: () => Promise.resolve(comparison) }); assert.equal(retained.ok, false); assert.match(retained.error, comparison === "changed" ? /inputs changed/ : /unavailable/);
  }
  const unavailable = await retainService(previous, previous, { compare: () => Promise.reject(new Error("private-runtime-value")) }); assert.equal(unavailable.ok, false); assert.equal(unavailable.error.includes("private-runtime-value"), false);
});


test("managed plans snapshot indexed arrays without trusting custom iterators and reject sparse mounts", () => {
  const mounts = [{ ...declaration.mounts[0] }];
  // eslint-disable-next-line functional/immutable-data -- untrusted input iterator must not change validated indexed mount values
  Object.defineProperty(mounts, Symbol.iterator, { value: function* () { yield { ...declaration.mounts[0], volume: { ...volume.value, app: "other" } }; } });
  const parsed = parseManagedServicePlan({ ...declaration, mounts }); assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.mounts, declaration.mounts);
  Object.assign(mounts[0] ?? {}, { readOnly: true });
  assert.equal(parsed.value.mounts[0]?.readOnly, false);
  assert.equal(parseManagedServicePlan({ ...declaration, mounts: Array(1) }).ok, false);
});


test("a synchronously failing comparison port is unavailable and cannot leak its private error", async () => {
  const result = await retainService(previous, previous, { compare: () => { throw new Error("sensitive-provider-error"); } });
  assert.equal(result.ok, false); assert.equal(result.error, "retained dependency input evidence is unavailable");
});
