import { parseCheckContainerFence } from "../../contracts/check-container-fence.ts";
import type { CheckContainerFencePort } from "../../contracts/check-container-fence.ts";
import { managedSwarmService } from "./managed-swarm-service.ts";
import { nativeField } from "./owned-swarm-service.ts";
import { dockerApi } from "./docker-api.ts";
import { typed } from "../../lib/typed.ts";

const terminal = new Set(["shutdown", "complete", "failed", "rejected", "remove", "orphaned"]);
/** Same privileged composition process and transport; no container writes, socket holder or separate controller. */
export const checkContainerFences = (api = dockerApi(), now: () => number = Date.now) => {
  const services = managedSwarmService(api);
  return Object.freeze(typed<CheckContainerFencePort>({ observe: async (input) => {
    const checked = parseCheckContainerFence(input); if (!checked.ok) return Object.freeze({ status: "foreign" });
    const { target, barrier, native } = checked.value;
    try {
      const observed = await services.observe({ app: barrier.app, incarnation: barrier.incarnation, dataOwner: barrier.dataOwner, service: barrier.service });
      if (observed.status === "foreign" || observed.status === "absent") return Object.freeze({ status: "foreign" }); if (observed.status !== "owned") return Object.freeze({ status: "unavailable" });
      if (observed.id !== native.id || observed.version < native.version || observed.action !== barrier.action || observed.plan !== barrier.plan || observed.effect !== "scrub") return Object.freeze({ status: "foreign" });
      if (!observed.tombstone || !observed.retainedInputsCleared || !observed.containersStopped || observed.replicas !== 0 || observed.endpoint !== "dnsrr" || ![null, "completed", "rollback_completed"].includes(observed.update) || observed.tasks.some((task) => !terminal.has(task.state))) return Object.freeze({ status: "pending" });
      const reply = await api.request("GET", `/containers/${target.container}/json`);
      if (reply.status !== 404 && reply.status !== 200) return Object.freeze({ status: "unavailable" });
      if (reply.status === 200) {
        const labels = nativeField(nativeField(reply.value, "Config"), "Labels"); const action = target.action;
        const expected = { "com.kayra.app": action.app, "com.kayra.incarnation": action.incarnation, "com.kayra.data-owner": action.dataOwner, "com.kayra.service": action.service, "com.kayra.action": action.action, "com.kayra.plan": action.plan, "com.kayra.effect": action.effect, "com.docker.swarm.service.id": target.service, "com.docker.swarm.task.id": target.task };
        if (nativeField(reply.value, "Id") !== target.container || Object.entries(expected).some(([key, value]) => nativeField(labels, key) !== value)) return Object.freeze({ status: "foreign" });
        const state = nativeField(reply.value, "State");
        if (nativeField(state, "Running") !== false || nativeField(state, "Restarting") !== false || nativeField(state, "Paused") !== false || !["exited", "dead"].includes(String(nativeField(state, "Status")))) return Object.freeze({ status: "pending" });
      }
      const at = now(); if (!Number.isSafeInteger(at) || at < 1) return Object.freeze({ status: "unavailable" });
      return Object.freeze({ status: "fenced", kind: reply.status === 404 ? "absent" : "stopped", native: Object.freeze({ id: observed.id, version: observed.version }), checkedAt: at });
    } catch { return Object.freeze({ status: "unavailable" }); }
  } }));
};
