import type { SwarmAuthority } from "../../contracts/swarm-authority.ts";
import type { SwarmHostObservation } from "../../contracts/resource-authority.ts";
import { typed } from "../../lib/typed.ts";
import { dockerApi } from "./docker-api.ts";

const record = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Read only normalized facts; raw Docker info and service environments never leave this adapter. */
export const observeSwarmHost = async (expected: SwarmAuthority, api = dockerApi()) => {
  try {
    const [host, version, network] = await Promise.all([
      api.request("GET", "/info"), api.request("GET", "/version"), api.request("GET", `/networks/${encodeURIComponent(expected.network.id)}`),
    ]);
    if (host.status !== 200 || version.status !== 200 || network.status !== 200 || !record(host.value) || !record(version.value) || !record(network.value)) return typed<SwarmHostObservation>({ status: "unavailable" });
    const info = host.value;
    const swarm = info["Swarm"];
    const engine = version.value["Version"];
    const apiVersion = version.value["ApiVersion"];
    if (typeof engine !== "string" || !engine.startsWith("29.") || typeof apiVersion !== "string" || !/^1\.[0-9]+$/.test(apiVersion)) return typed<SwarmHostObservation>({ status: "unsupported" });
    if (!positive(info["NCPU"]) || !positive(info["MemTotal"]) || expected.profile.cpu_millicores > info["NCPU"] * 1000 || expected.profile.memory_bytes > info["MemTotal"]) return typed<SwarmHostObservation>({ status: "changed" });
    if (!record(swarm) || swarm["LocalNodeState"] !== "active" || swarm["ControlAvailable"] !== true || swarm["Nodes"] !== 1 || swarm["Managers"] !== 1 ||
      swarm["NodeID"] !== expected.node || swarm["NodeAddr"] !== expected.profile.advertise_address || !record(swarm["Cluster"]) || swarm["Cluster"]["ID"] !== expected.cluster) return typed<SwarmHostObservation>({ status: "changed" });
    const overlay = network.value;
    if (overlay["Id"] !== expected.network.id || overlay["Name"] !== expected.network.name || overlay["Driver"] !== "overlay" || overlay["Scope"] !== "swarm" || overlay["Attachable"] !== true || overlay["Ingress"] !== false) return typed<SwarmHostObservation>({ status: "changed" });
    return typed<SwarmHostObservation>(Object.freeze({
      status: "ready", engine, api: apiVersion, node: expected.node, cluster: expected.cluster, network: expected.network.id,
      capacity: Object.freeze({ cpu: expected.profile.cpu_millicores, memory: expected.profile.memory_bytes }),
      standing: Object.freeze({ cpu: expected.profile.platform_cpu_millicores, memory: expected.profile.platform_memory_bytes }),
    }));
  } catch {
    return typed<SwarmHostObservation>({ status: "unavailable" });
  }
};
