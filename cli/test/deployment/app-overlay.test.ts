/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data, functional/type-declaration-immutability -- isolated runtime responses and clock */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { appOverlayActionSchema, parseAppOverlayScope } from "../../src/contracts/app-overlay.ts";
import type { AppOverlayGrant, AppOverlayObservation, AppOverlayPort } from "../../src/contracts/app-overlay.ts";
import { parseSwarmAuthority } from "../../src/contracts/swarm-authority.ts";
import { appOverlayRequest, provisionAppOverlay } from "../../src/server/platform/app-overlay.ts";
import { appOverlays } from "../../src/server/runtime/app-overlay.ts";
import type { DockerReply } from "../../src/server/runtime/docker-api.ts";

const incarnation = randomUUID();
const parsed = parseAppOverlayScope({ version: 1, app: "shop", incarnation, node: "a".repeat(25), cluster: "b".repeat(25), name: `kayra-app-${incarnation}` }); assert.ok(parsed.ok); const scope = parsed.value;
const action = { scope, operation: randomUUID(), deadline: 91000 };
const id = "n".repeat(25); const grant: AppOverlayGrant = { scope, id };
const info = { Swarm: { LocalNodeState: "active", ControlAvailable: true, NodeID: scope.node, Cluster: { ID: scope.cluster }, Nodes: 1, Managers: 1 } };
const network = () => ({ Id: id, Name: scope.name, Driver: "overlay", Scope: "swarm", Attachable: true, Internal: false, Ingress: false, EnableIPv6: false, ConfigOnly: false,
  Labels: { "com.kayra.app": scope.app, "com.kayra.incarnation": scope.incarnation, "com.kayra.node": scope.node, "com.kayra.cluster": scope.cluster, "com.kayra.network-kind": "app", "com.kayra.network-version": "1" },
  Options: { "com.docker.network.driver.overlay.vxlanid_list": "4098" }, IPAM: { Driver: "default", Options: null, Config: [] }, ConfigFrom: { Network: "" }, Containers: { private: { IPv4Address: "raw-private-address" } },
});
type Args = Parameters<NonNullable<Parameters<typeof appOverlays>[0]>["request"]>;
const fake = (respond: (...args: Args) => DockerReply | Promise<DockerReply>) => {
  const calls: Args[] = []; return { calls, request: async (...args: Args) => { calls.push(args); return await respond(...args); } };
};
const observed = (value: unknown = network()) => fake((_method, path) => path === "/info" ? { status: 200, value: info } : path.startsWith("/networks?") ? { status: 200, value: [value] } : { status: 200, value });

test("network scope is incarnation-specific and cannot name platform routing infrastructure", () => {
  assert.ok(Object.isFrozen(scope)); assert.equal(parseAppOverlayScope({ ...scope, name: "platform-swarm" }).ok, false);
  assert.equal(parseAppOverlayScope({ ...scope, app: "../other" }).ok, false); assert.equal(appOverlayActionSchema.safeParse({ ...action, force: true }).success, false);
  const host = parseSwarmAuthority(JSON.parse(readFileSync(new URL("../../../ci/tests/swarm-host/authority.json", import.meta.url), "utf8"))); assert.ok(host.ok);
  const registration = { version: 1, app: scope.app, incarnation, actionId: `${incarnation}:1`, registrationGeneration: randomUUID() } as const;
  const selected = appOverlayRequest(registration, "swarm", host.value, randomUUID(), 91000); assert.ok(selected.ok); assert.equal(selected.value.scope.name, scope.name);
  assert.equal(appOverlayRequest(registration, "compose", host.value, randomUUID(), 91000).ok, false);
});

test("observations expose only exact scope and physical ID, without raw endpoint data", async () => {
  const port = appOverlays(observed(), () => 1000); assert.deepEqual(await port.observe(scope), { status: "owned", grant });
  assert.equal(JSON.stringify(await port.observe(scope)).includes("raw-private-address"), false);
});

test("fixed overlay creation observes first, creates once and reconciles by exact ownership", async () => {
  let present = false;
  const runtime = fake((method, path) => {
    if (method === "POST") { present = true; return { status: 201, value: { Id: id } }; }
    return path === "/info" ? { status: 200, value: info } : path.startsWith("/networks?") ? { status: 200, value: present ? [network()] : [] } : { status: 200, value: network() };
  });
  const port = appOverlays(runtime, () => 1000); assert.equal(await port.create(action), "acknowledged"); assert.equal(await port.create(action), "acknowledged");
  assert.equal(runtime.calls.filter(([method]) => method === "POST").length, 1);
  const payload = runtime.calls.find(([method]) => method === "POST")?.[2]; assert.deepEqual(payload, { Name: scope.name, Driver: "overlay", Scope: "swarm", CheckDuplicate: true, Attachable: true, Internal: false, Ingress: false, EnableIPv6: false, ConfigOnly: false, Options: {}, IPAM: { Driver: "default", Config: [], Options: {} }, Labels: network().Labels });
});

test("foreign networks and unexpected driver options refuse writes", async () => {
  for (const value of [{ ...network(), Driver: "bridge" }, { ...network(), Attachable: false }, { ...network(), Labels: { ...network().Labels, "com.kayra.app": "other" } },
    { ...network(), Labels: { ...network().Labels, unexpected: "value" } }, { ...network(), Options: { "driver-injected": "value" } }, { ...network(), Internal: true }, { ...network(), ConfigOnly: true }, { ...network(), EnableIPv6: true }]) {
    const runtime = observed(value); const port = appOverlays(runtime, () => 1000); assert.equal((await port.observe(scope)).status, "foreign"); assert.equal(await port.create(action), "conflict"); assert.equal(runtime.calls.some(([method]) => method === "POST"), false);
  }
});

test("duplicate names are ambiguous and never choose a network or create another", async () => {
  const runtime = fake((_method, path) => path === "/info" ? { status: 200, value: info } : { status: 200, value: [network(), { ...network(), Id: "m".repeat(25) }] });
  const port = appOverlays(runtime, () => 1000); assert.equal((await port.observe(scope)).status, "ambiguous"); assert.equal(await port.create(action), "conflict");
  assert.equal(runtime.calls.some(([method]) => method === "POST"), false);
});

test("expired, overlong and invalid actions refuse before Docker access", async () => {
  const runtime = fake(() => { throw new Error("must not call Docker"); }); const port = appOverlays(runtime, () => 1000);
  for (const value of [{ ...action, deadline: 1000 }, { ...action, deadline: 91001 }, { ...action, operation: "invalid" }]) assert.equal(await port.create(value), "refused");
  assert.equal(runtime.calls.length, 0);
});

test("changed node/cluster authority and unavailable metadata cannot cause network creation", async () => {
  for (const value of [{ Swarm: { ...info.Swarm, NodeID: "c".repeat(25) } }, { Swarm: { ...info.Swarm, Managers: 2 } }]) {
    const runtime = fake((_method, path) => path === "/info" ? { status: 200, value } : { status: 200, value: [] });
    assert.equal(await appOverlays(runtime, () => 1000).create(action), "conflict"); assert.equal(runtime.calls.some(([method]) => method === "POST"), false);
  }
  const runtime = fake(() => ({ status: 500, value: null })); assert.equal(await appOverlays(runtime, () => 1000).create(action), "uncertain");
});

test("platform provisioning preserves a stored ID and refuses missing, replaced or foreign evidence", async () => {
  let creates = 0;
  const port: AppOverlayPort = { observe: () => Promise.resolve({ status: "owned", grant }), create: () => { creates++; return Promise.resolve("acknowledged"); } };
  assert.deepEqual(await provisionAppOverlay(action, grant, port, () => 1000), { ok: true, value: grant });
  for (const observation of [{ status: "absent" }, { status: "owned", grant: { scope, id: "m".repeat(25) } }, { status: "owned", grant: { scope: { ...scope, app: "other" }, id } }] as const) {
    const refused = await provisionAppOverlay(action, grant, { ...port, observe: () => Promise.resolve(observation) }, () => 1000); assert.equal(refused.ok, false);
  }
  assert.equal(creates, 0);
});

test("uncertain initial creation is observed once and never blindly retried by platform policy", async () => {
  let observedCount = 0; let creates = 0;
  const port: AppOverlayPort = { observe: () => Promise.resolve(++observedCount === 1 ? { status: "absent" } : { status: "owned", grant }), create: () => { creates++; return Promise.resolve("uncertain"); } };
  assert.deepEqual(await provisionAppOverlay(action, null, port, () => 1000), { ok: true, value: grant }); assert.equal(creates, 1);
  const failed = await provisionAppOverlay(action, null, { ...port, observe: () => { throw new Error("private-driver-message"); } }, () => 1000); assert.equal(failed.ok, false); assert.equal(failed.error.includes("private"), false);
});


test("post-create allocation settles through read-only observation without another Create", async () => {
  let observations = 0; let creates = 0;
  const port: AppOverlayPort = { observe: () => Promise.resolve(++observations === 1 ? { status: "absent" } : observations === 2 ? { status: "foreign" } : { status: "owned", grant }), create: () => { creates++; return Promise.resolve("acknowledged"); } };
  assert.deepEqual(await provisionAppOverlay(action, null, port, () => 1000), { ok: true, value: grant }); assert.equal(creates, 1); assert.equal(observations, 3);
});

test("an unsettled or hung overlay observation cannot extend the original deadline", async () => {
  const deadline = Date.now() + 120; let creates = 0; let observations = 0; const gate = Promise.withResolvers<AppOverlayObservation>();
  const port: AppOverlayPort = { observe: () => ++observations === 1 ? Promise.resolve({ status: "absent" }) : gate.promise, create: () => { creates++; return Promise.resolve("acknowledged"); } };
  const result = await provisionAppOverlay({ ...action, deadline }, null, port); assert.equal(result.ok, false); assert.equal(creates, 1); assert.equal(observations, 2); gate.resolve({ status: "owned", grant });
});
