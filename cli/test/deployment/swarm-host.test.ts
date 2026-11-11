import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSwarmAuthority } from "../../src/contracts/swarm-authority.ts";
import type { dockerApi } from "../../src/server/runtime/docker-api.ts";
import { observeSwarmHost } from "../../src/server/runtime/swarm-host.ts";

const input: unknown = JSON.parse(readFileSync(new URL("../../../ci/tests/swarm-host/authority.json", import.meta.url), "utf8"));
const checked = parseSwarmAuthority(input);
assert.ok(checked.ok);
const authority = checked.value;
const info = { NCPU: 2, MemTotal: 4 * 1024**3, Swarm: { LocalNodeState: "active", ControlAvailable: true, Nodes: 1, Managers: 1, NodeID: authority.node, NodeAddr: authority.profile.advertise_address, Cluster: { ID: authority.cluster } }, PrivateIgnoredValue: "PRIVATE-OBSERVATION" };
const version = { Version: "29.9.3", ApiVersion: "1.56" };
const network = { Id: authority.network.id, Name: authority.network.name, Driver: "overlay", Scope: "swarm", Attachable: true, Ingress: false };
const fixture = (host: unknown = info, daemon: unknown = version, overlay: unknown = network) => {
  const api: ReturnType<typeof dockerApi> = { request: (method, path) => {
    assert.equal(method, "GET");
    return Promise.resolve({ status: 200, value: path === "/info" ? host : path === "/version" ? daemon : overlay });
  } };
  return api;
};

test("Swarm host observations bind declared budgets to exact live identities and omit raw data", async () => {
  const observation = await observeSwarmHost(authority, fixture());
  assert.deepEqual(observation, {
    status: "ready", engine: version.Version, api: version.ApiVersion, node: authority.node, cluster: authority.cluster, network: authority.network.id,
    capacity: { cpu: 2000, memory: 3 * 1024**3 }, standing: { cpu: 500, memory: 1024**3 },
  });
  assert.equal(JSON.stringify(observation).includes("PRIVATE-OBSERVATION"), false);
});

test("changed membership, overlay or host capacity prevents admission", async () => {
  for (const host of [{ ...info, NCPU: 1 }, { ...info, MemTotal: 1024**3 }, { ...info, Swarm: { ...info.Swarm, Nodes: 2 } }, { ...info, Swarm: { ...info.Swarm, NodeID: "changed" } }, { ...info, Swarm: { ...info.Swarm, Cluster: { ID: "changed" } } }, { ...info, Swarm: { ...info.Swarm, NodeAddr: "192.0.2.2" } }]) assert.deepEqual(await observeSwarmHost(authority, fixture(host)), { status: "changed" });
  for (const overlay of [{ ...network, Id: "changed" }, { ...network, Driver: "bridge" }, { ...network, Attachable: false }]) assert.deepEqual(await observeSwarmHost(authority, fixture(info, version, overlay)), { status: "changed" });
  assert.deepEqual(await observeSwarmHost(authority, fixture(info, { ...version, Version: "30.0.0" })), { status: "unsupported" });
  assert.deepEqual(await observeSwarmHost(authority, { request: () => Promise.reject(new Error("PRIVATE-ERROR")) }), { status: "unavailable" });
});
