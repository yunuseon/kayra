/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data, functional/type-declaration-immutability -- owns fake runtime responses and clock */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ownedVolume, parseOwnedVolume } from "../../src/contracts/owned-volume.ts";
import { ownedVolumes } from "../../src/server/runtime/owned-volume.ts";
import type { DockerReply } from "../../src/server/runtime/docker-api.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const allocation = "22222222-2222-4222-8222-222222222222";
const operation = "33333333-3333-4333-8333-333333333333";
const checked = ownedVolume("shop", owner, allocation, "database"); if (!checked.ok) throw new Error(checked.error); const volume = checked.value;
const action = { volume, operation, deadline: 90000 };
const data = () => ({ Name: volume.name, Driver: "local", Scope: "local", Options: null, CreatedAt: "2026-11-14T12:00:00Z",
  Labels: { "com.kayra.app": "shop", "com.kayra.data-owner": owner, "com.kayra.volume-key": "database", "com.kayra.volume-allocation": allocation, "com.kayra.volume-version": "1" }, Mountpoint: "/private/docker-root/never-publish" });
type Args = Parameters<Parameters<typeof ownedVolumes>[0]["request"]>;
const fake = (respond: (...args: Args) => DockerReply | Promise<DockerReply>) => {
  const calls: Args[] = [];
  return { calls, request: async (...args: Args) => { calls.push(args); return respond(...args); } };
};
const expected = { volume, createdAt: data().CreatedAt };
const empty = (path: string) => path.startsWith("/volumes/") ? { status: 200, value: data() } : { status: 200, value: [] };

test("data ownership survives app reincarnation while a fresh allocation gets a different physical name", () => {
  assert.equal(volume.dataOwner, owner); assert.equal(volume.name, "kayra-data-" + allocation); assert.ok(Object.isFrozen(volume));
  const recreated = ownedVolume("shop", owner, "44444444-4444-4444-8444-444444444444", "database"); assert.ok(recreated.ok); assert.notEqual(recreated.value.name, volume.name); assert.equal(recreated.value.dataOwner, volume.dataOwner);
  for (const value of [{ ...volume, name: "foreign" }, { ...volume, allocation: "bad" }, { ...volume, app: "../foreign" }, { ...volume, key: "../host" }, { ...volume, driver: "external" }]) assert.equal(parseOwnedVolume(value).ok, false);
});

test("only exact owned local-driver identities are observed and mountpoints are never projected", async () => {
  const runtime = fake(() => ({ status: 200, value: data() })); const observed = await ownedVolumes(runtime).observe(volume); assert.equal(observed.status, "owned"); assert.equal(JSON.stringify(observed).includes("docker-root"), false);
  for (const value of [{ ...data(), Driver: "nfs" }, { ...data(), Scope: "global" }, { ...data(), Options: { device: "/host" } }, { ...data(), Labels: null }, { ...data(), Labels: { ...data().Labels, "com.kayra.data-owner": operation } }, { ...data(), Name: "foreign" }]) {
    assert.equal((await ownedVolumes(fake(() => ({ status: 200, value }))).observe(volume)).status, "foreign");
  }
  assert.equal((await ownedVolumes(fake(() => ({ status: 404, value: null }))).observe(volume)).status, "absent");
});

test("creation uses one fixed local named volume request and never adopts a foreign existing volume", async () => {
  const runtime = fake((method) => method === "GET" ? { status: 404, value: null } : { status: 201, value: data() });
  assert.equal(await ownedVolumes(runtime, () => 1000).create(action), "acknowledged"); assert.equal(runtime.calls.filter(([method]) => method === "POST").length, 1);
  assert.deepEqual(runtime.calls[1]?.slice(0, 3), ["POST", "/volumes/create", { Name: volume.name, Driver: "local", DriverOpts: {}, Labels: data().Labels }]);
  const existing = fake(() => ({ status: 200, value: data() })); assert.equal(await ownedVolumes(existing, () => 1000).create(action), "acknowledged"); assert.equal(existing.calls.length, 1);
  const foreign = fake(() => ({ status: 200, value: { ...data(), Labels: {} } })); assert.equal(await ownedVolumes(foreign, () => 1000).create(action), "conflict"); assert.equal(foreign.calls.length, 1);
});

test("invalid and expired write identities are refused before contacting Docker", async () => {
  const runtime = fake(() => { throw new Error("unexpected runtime access"); }); const port = ownedVolumes(runtime, () => 1000);
  assert.equal(await port.create({ ...action, deadline: 1000 }), "refused"); assert.equal(await port.create({ ...action, deadline: 92000 }), "refused"); assert.equal(await port.create({ ...action, operation: "invalid" }), "refused");
  assert.equal(await port.remove(action, { ...expected, volume: { ...volume, name: "foreign" } }), "refused"); assert.equal(runtime.calls.length, 0);
});

test("stopped containers and both current and PreviousSpec service mounts block removal", async () => {
  const spec = (source: string | null) => ({ TaskTemplate: { ContainerSpec: { Mounts: source === null ? [] : [{ Type: "volume", Source: source, Target: "/data" }] } }, Mode: { Replicated: { Replicas: 0 } } });
  const runtime = fake((_method, path) => path.startsWith("/containers/") ? { status: 200, value: [{ Id: "a".repeat(64), State: "exited", Mounts: [{ Type: "volume", Name: volume.name }] }] } : path === "/services" ?
    { status: 200, value: [{ ID: "b".repeat(25), Spec: spec(volume.name) }, { ID: "c".repeat(25), Spec: spec(null), PreviousSpec: spec(volume.name) }] } : { status: 200, value: data() });
  const port = ownedVolumes(runtime, () => 1000); assert.deepEqual(await port.attachments(volume), { status: "observed", containers: ["a".repeat(64)], services: ["b".repeat(25), "c".repeat(25)] });
  assert.equal(await port.remove(action, expected), "attached"); assert.equal(runtime.calls.some(([method]) => method === "DELETE"), false);
});

test("removal rechecks ownership, uses force=false and retains Docker's attachment-race refusal", async () => {
  const runtime = fake((method, path) => method === "DELETE" ? { status: 204, value: null } : empty(path)); assert.equal(await ownedVolumes(runtime, () => 1000).remove(action, expected), "acknowledged");
  assert.deepEqual(runtime.calls.filter(([method]) => method === "DELETE").map((call) => call.slice(0, 3)), [["DELETE", "/volumes/" + volume.name + "?force=false", undefined]]);
  const raced = fake((method, path) => method === "DELETE" ? { status: 409, value: { message: "in use" } } : empty(path)); assert.equal(await ownedVolumes(raced, () => 1000).remove(action, expected), "attached");
});

test("a changed creation receipt or unknown attachment evidence cannot authorize deletion", async () => {
  for (const broken of [null, {}, [{ ID: "bad", Spec: {} }], [{ ID: "b".repeat(25), Spec: { TaskTemplate: { ContainerSpec: { Mounts: [{ Type: "unknown", Source: volume.name }] } } } }]]) {
    const runtime = fake((_method, path) => path === "/services" ? { status: 200, value: broken } : empty(path)); assert.equal(await ownedVolumes(runtime, () => 1000).remove(action, expected), "uncertain"); assert.equal(runtime.calls.some(([method]) => method === "DELETE"), false);
  }
  const changed = fake((_method, path) => path.startsWith("/volumes/") ? { status: 200, value: { ...data(), CreatedAt: "2026-11-14T12:00:01Z" } } : empty(path)); assert.equal(await ownedVolumes(changed, () => 1000).remove(action, expected), "conflict"); assert.equal(changed.calls.length, 1);
});

test("late reads cannot extend a write deadline and uncertain creation is never retried", async () => {
  let clock = 1000;
  const runtime = fake((_method, path) => { if (path === "/services") clock = 90001; return empty(path); }); assert.equal(await ownedVolumes(runtime, () => clock).remove(action, expected), "refused"); assert.equal(runtime.calls.some(([method]) => method === "DELETE"), false);
  const uncertain = fake((method) => { if (method === "GET") return { status: 404, value: null }; throw new Error("lost response"); }); assert.equal(await ownedVolumes(uncertain, () => 1000).create(action), "uncertain"); assert.equal(uncertain.calls.filter(([method]) => method === "POST").length, 1);
});

test("a caller mutation during an observation cannot redirect volume creation", async () => {
  const input = { ...action, volume: { ...volume } };
  const runtime = fake((method, _path, body) => { if (method === "GET") { input.volume.name = "foreign"; return { status: 404, value: null }; } assert.deepEqual(body, { Name: volume.name, Driver: "local", DriverOpts: {}, Labels: data().Labels }); return { status: 201, value: data() }; });
  assert.equal(await ownedVolumes(runtime, () => 1000).create(input), "acknowledged");
});


test("an absent volume with a pending service reference is still attached", async () => {
  const runtime = fake((_method, path) => path.startsWith("/volumes/") ? { status: 404, value: null } : path === "/services" ?
    { status: 200, value: [{ ID: "b".repeat(25), Spec: { TaskTemplate: { ContainerSpec: { Mounts: [{ Type: "volume", Source: volume.name, Target: "/data" }] } } } }] } : { status: 200, value: [] });
  assert.equal(await ownedVolumes(runtime, () => 1000).remove(action, expected), "attached"); assert.equal(runtime.calls.some(([method]) => method === "DELETE"), false);
});
