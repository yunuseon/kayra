import { err, ok } from "../lib/result.ts";
import { typed } from "../lib/typed.ts";

export type SwarmGrants = {
  readonly memory_bytes: number;
  readonly cpu_millicores: number;
  readonly maintenance: boolean;
};
export type SwarmProfile = {
  readonly enabled: true;
  readonly advertise_address: string;
  readonly memory_bytes: number;
  readonly cpu_millicores: number;
  readonly platform_memory_bytes: number;
  readonly platform_cpu_millicores: number;
};
export type SwarmAuthority = {
  readonly version: 1;
  readonly profile: SwarmProfile;
  readonly node: string;
  readonly cluster: string;
  readonly network: { readonly name: "platform-swarm"; readonly id: string };
};
const record = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Readonly<Record<string, unknown>>, expected: readonly string[]) => Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const identity = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]{25}$/.test(value);
const ipv4 = (value: unknown): value is string => typeof value === "string" && value.split(".").length === 4 && value.split(".").every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255 && String(Number(part)) === part);

export const parseSwarmGrants = (value: unknown) => {
  if (!record(value) || !keys(value, ["memory_bytes", "cpu_millicores", "maintenance"]) || !positive(value["memory_bytes"]) || !positive(value["cpu_millicores"]) || typeof value["maintenance"] !== "boolean") return err("explicit Swarm resource and maintenance grants are required");
  return ok<SwarmGrants>(Object.freeze({ memory_bytes: value["memory_bytes"], cpu_millicores: value["cpu_millicores"], maintenance: value["maintenance"] }));
};

export const parseSwarmAuthority = (value: unknown) => {
  if (!record(value) || !keys(value, ["version", "profile", "node", "cluster", "network"]) || value["version"] !== 1 || !identity(value["node"]) || !identity(value["cluster"])) return err("invalid Swarm host authority");
  const profile = value["profile"];
  const network = value["network"];
  if (!record(profile) || !keys(profile, ["enabled", "advertise_address", "memory_bytes", "cpu_millicores", "platform_memory_bytes", "platform_cpu_millicores"]) || profile["enabled"] !== true || !ipv4(profile["advertise_address"]) ||
    !positive(profile["memory_bytes"]) || !positive(profile["cpu_millicores"]) || !positive(profile["platform_memory_bytes"]) || !positive(profile["platform_cpu_millicores"]) || profile["platform_memory_bytes"] >= profile["memory_bytes"] || profile["platform_cpu_millicores"] >= profile["cpu_millicores"] ||
    !record(network) || !keys(network, ["name", "id"]) || network["name"] !== "platform-swarm" || !identity(network["id"])) return err("invalid Swarm host authority");
  return ok<SwarmAuthority>(Object.freeze({
    version: 1, node: value["node"], cluster: value["cluster"], network: Object.freeze({ name: network["name"], id: network["id"] }),
    profile: Object.freeze(typed<SwarmProfile>({ enabled: true, advertise_address: profile["advertise_address"], memory_bytes: profile["memory_bytes"], cpu_millicores: profile["cpu_millicores"], platform_memory_bytes: profile["platform_memory_bytes"], platform_cpu_millicores: profile["platform_cpu_millicores"] })),
  }));
};

export const admitSwarmGrants = (authority: SwarmAuthority, grants: SwarmGrants) =>
  grants.memory_bytes <= authority.profile.memory_bytes - authority.profile.platform_memory_bytes && grants.cpu_millicores <= authority.profile.cpu_millicores - authority.profile.platform_cpu_millicores
    ? ok(true) : err("app grants exceed declared Swarm workload capacity");
