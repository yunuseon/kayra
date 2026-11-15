import { appOverlayActionSchema, parseAppOverlayScope } from "../../contracts/app-overlay.ts";
import type { AppOverlayObservation, AppOverlayPort, AppOverlayScope } from "../../contracts/app-overlay.ts";
import { typed } from "../../lib/typed.ts";
import { dockerApi } from "./docker-api.ts";

const record = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, key: string) => record(value) ? value[key] : undefined;
const empty = (value: unknown) => value === null || value === undefined || record(value) && Object.keys(value).length === 0;
const labels = (scope: AppOverlayScope) => Object.freeze({ "com.kayra.app": scope.app, "com.kayra.incarnation": scope.incarnation,
  "com.kayra.node": scope.node, "com.kayra.cluster": scope.cluster, "com.kayra.network-kind": "app", "com.kayra.network-version": "1" });
const normalized = (value: AppOverlayObservation) => Object.freeze(value);
const owned = (scope: AppOverlayScope, network: Readonly<Record<string, unknown>>) => {
  const actual = network["Labels"]; const expected = labels(scope); const options = network["Options"]; const ipam = network["IPAM"];
  return network["Name"] === scope.name && network["Driver"] === "overlay" && network["Scope"] === "swarm" && network["Attachable"] === true &&
    network["Internal"] === false && network["Ingress"] === false && network["EnableIPv6"] === false && network["ConfigOnly"] === false &&
    record(actual) && Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => actual[key] === value) &&
    (empty(options) || record(options) && Object.entries(options).every(([key, value]) => key === "com.docker.network.driver.overlay.vxlanid_list" && typeof value === "string" &&
      /^[1-9][0-9]*(?:,[1-9][0-9]*)*$/.test(value) && value.split(",").every((item) => Number.isSafeInteger(Number(item)) && Number(item) < 16777216))) &&
    record(ipam) && ipam["Driver"] === "default" && empty(ipam["Options"]) &&
    (empty(network["ConfigFrom"]) || record(network["ConfigFrom"]) && Object.keys(network["ConfigFrom"]).length === 1 && network["ConfigFrom"]["Network"] === "");
};

/** Creates only an incarnation-scoped overlay under fixed platform policy; never renders workloads or deletes networks. */
export const appOverlays = (api: Pick<ReturnType<typeof dockerApi>, "request"> = dockerApi(), now: () => number = Date.now) => {
  const observe: AppOverlayPort["observe"] = async (input) => {
    const checked = parseAppOverlayScope(input); if (!checked.ok) return normalized({ status: "foreign" }); const scope = checked.value;
    try {
      const [info, networks] = await Promise.all([api.request("GET", "/info"), api.request("GET", `/networks?filters=${encodeURIComponent(JSON.stringify({ name: [scope.name] }))}`)]);
      if (info.status !== 200 || networks.status !== 200 || !Array.isArray(networks.value)) return normalized({ status: "unavailable" });
      const swarm = field(info.value, "Swarm");
      if (field(swarm, "LocalNodeState") !== "active" || field(swarm, "ControlAvailable") !== true || field(swarm, "Nodes") !== 1 || field(swarm, "Managers") !== 1 ||
        field(swarm, "NodeID") !== scope.node || field(field(swarm, "Cluster"), "ID") !== scope.cluster) return normalized({ status: "foreign" });
      if (networks.value.some((network: unknown) => !record(network) || typeof network["Name"] !== "string")) return normalized({ status: "unavailable" });
      const candidates: readonly unknown[] = networks.value.filter((network: unknown) => field(network, "Name") === scope.name);
      if (candidates.length === 0) return normalized({ status: "absent" });
      if (candidates.length !== 1) return normalized({ status: "ambiguous" });
      const id = field(candidates[0], "Id"); if (typeof id !== "string" || !/^[a-z0-9]{25}$/.test(id)) return normalized({ status: "foreign" });
      const reply = await api.request("GET", `/networks/${encodeURIComponent(id)}`);
      if (reply.status !== 200 || !record(reply.value)) return normalized({ status: "unavailable" });
      return normalized(reply.value["Id"] === id && owned(scope, reply.value) ? { status: "owned", grant: Object.freeze({ scope, id }) } : { status: "foreign" });
    } catch { return normalized({ status: "unavailable" }); }
  };
  return typed<AppOverlayPort>(Object.freeze({ observe,
    create: async (input) => {
      const checked = appOverlayActionSchema.safeParse(input); if (!checked.success) return "refused"; const action = checked.data;
      const remaining = action.deadline - now(); if (!Number.isSafeInteger(remaining) || remaining <= 0 || remaining > 90000) return "refused";
      const before = await observe(action.scope); if (before.status === "owned") return "acknowledged";
      if (before.status !== "absent") return before.status === "unavailable" ? "uncertain" : "conflict";
      const left = action.deadline - now(); if (!Number.isSafeInteger(left) || left <= 0) return "refused";
      try {
        const reply = await api.request("POST", "/networks/create", { Name: action.scope.name, Driver: "overlay", Scope: "swarm", CheckDuplicate: true,
          Attachable: true, Internal: false, Ingress: false, EnableIPv6: false, ConfigOnly: false, Options: {}, IPAM: { Driver: "default", Config: [], Options: {} }, Labels: labels(action.scope),
        }, { timeoutMs: Math.min(10000, left) });
        return reply.status === 201 && typeof field(reply.value, "Id") === "string" && /^[a-z0-9]{25}$/.test(String(field(reply.value, "Id"))) ? "acknowledged" : "uncertain";
      } catch { return "uncertain"; }
    },
  }));
};
