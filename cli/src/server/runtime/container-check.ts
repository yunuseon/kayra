import { parseCheckTarget, parseContainerCheckPlan } from "../../contracts/container-check.ts";
import type { CheckTarget, ContainerCheckPlan, ContainerCheckPort, CheckTargetPort } from "../../contracts/container-check.ts";
import { managedServiceName } from "../../contracts/managed-service-plan.ts";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { ManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import { typed } from "../../lib/typed.ts";
import { dockerApi } from "./docker-api.ts";
import { nativeField, nativeRecord, validNativeVersion } from "./owned-swarm-service.ts";

const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const taskId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]{25}$/.test(value);
const settled = (value: unknown) => value === undefined || value === "completed" || value === "rollback_completed";
const unprivileged = (value: unknown) => value === undefined || value === false;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const owns = (value: unknown, action: ManagedServiceAction) => nativeRecord(value) && value["com.kayra.app"] === action.app && value["com.kayra.incarnation"] === action.incarnation && value["com.kayra.data-owner"] === action.dataOwner && value["com.kayra.service"] === action.service;
const matchesAction = (value: unknown, action: ManagedServiceAction) => owns(value, action) && nativeField(value, "com.kayra.action") === action.action && nativeField(value, "com.kayra.plan") === action.plan && nativeField(value, "com.kayra.effect") === action.effect;

/** Docker Exec API v1.56: https://docs.docker.com/reference/api/engine/version/v1.56/ . No output capture, privilege expansion or workload creation. */
export const containerChecks = (api = dockerApi(), now: () => number = Date.now) => {
  const inspectContainer = async (target: CheckTarget, live: boolean, timeoutMs = 10_000) => {
    const reply = await api.request("GET", `/containers/${target.container}/json`, undefined, { timeoutMs });
    if (reply.status === 404) return "absent" as const; if (reply.status !== 200) return "unavailable" as const;
    const labels = nativeField(nativeField(reply.value, "Config"), "Labels");
    if (nativeField(reply.value, "Id") !== target.container || !matchesAction(labels, target.action) || nativeField(labels, "com.docker.swarm.service.id") !== target.service || nativeField(labels, "com.docker.swarm.task.id") !== target.task) return "foreign" as const;
    if (live) {
      const state = nativeField(reply.value, "State"); if (nativeField(state, "Running") !== true || nativeField(state, "Paused") === true || nativeField(state, "Restarting") === true || nativeField(nativeField(state, "Health"), "Status") !== "healthy") return "unavailable" as const;
    }
    return "owned" as const;
  };
  const current = async (target: CheckTarget, timeoutMs = 10_000) => {
    const service = await api.request("GET", `/services/${target.service}`, undefined, { timeoutMs }); const task = await api.request("GET", `/tasks/${target.task}`, undefined, { timeoutMs });
    if (service.status === 404 || task.status === 404) return "absent" as const; if (service.status !== 200 || task.status !== 200) return "unavailable" as const;
    const spec = nativeField(service.value, "Spec"); const template = nativeField(spec, "TaskTemplate"); const taskContainer = nativeField(nativeField(task.value, "Spec"), "ContainerSpec");
    if (nativeField(service.value, "ID") !== target.service || nativeField(spec, "Name") !== managedServiceName(target.action, target.action.service) || !owns(nativeField(spec, "Labels"), target.action) || !matchesAction(nativeField(nativeField(template, "ContainerSpec"), "Labels"), target.action) ||
      nativeField(task.value, "ID") !== target.task || nativeField(task.value, "ServiceID") !== target.service || !matchesAction(nativeField(taskContainer, "Labels"), target.action) || nativeField(nativeField(nativeField(task.value, "Status"), "ContainerStatus"), "ContainerID") !== target.container) return "foreign" as const;
    if (nativeField(nativeField(nativeField(spec, "Mode"), "Replicated"), "Replicas") !== 1 || nativeField(task.value, "DesiredState") !== "running" || nativeField(nativeField(task.value, "Status"), "State") !== "running" || !settled(nativeField(nativeField(service.value, "UpdateStatus"), "State"))) return "unavailable" as const;
    return inspectContainer(target, true, timeoutMs);
  };
  const observe = async (input: ContainerCheckPlan, exec: string) => {
    const checked = parseContainerCheckPlan(input); if (!checked.ok || !id(exec)) return typed<Awaited<ReturnType<ContainerCheckPort["observe"]>>>({ status: "foreign" });
    const plan = checked.value;
    try {
      const container = await inspectContainer(plan.target, false); if (container !== "owned") return typed<Awaited<ReturnType<ContainerCheckPort["observe"]>>>({ status: container });
      const reply = await api.request("GET", `/exec/${exec}/json`); if (reply.status === 404) return typed<Awaited<ReturnType<ContainerCheckPort["observe"]>>>({ status: "absent" }); if (reply.status !== 200) return typed<Awaited<ReturnType<ContainerCheckPort["observe"]>>>({ status: "unavailable" });
      const config = nativeField(reply.value, "ProcessConfig"); const args = nativeField(config, "arguments");
      if (nativeField(reply.value, "ID") !== exec || nativeField(reply.value, "ContainerID") !== plan.target.container || nativeField(config, "entrypoint") !== plan.command[0] || !same(args ?? [], plan.command.slice(1)) || !unprivileged(nativeField(config, "privileged")) || nativeField(config, "tty") !== false || ["OpenStdin", "OpenStdout", "OpenStderr"].some((key) => nativeField(reply.value, key) !== false)) return typed<Awaited<ReturnType<ContainerCheckPort["observe"]>>>({ status: "foreign" });
      const running = nativeField(reply.value, "Running"); const exit = nativeField(reply.value, "ExitCode"); if (typeof running !== "boolean" || typeof exit !== "number" || !Number.isSafeInteger(exit)) return typed<Awaited<ReturnType<ContainerCheckPort["observe"]>>>({ status: "unavailable" });
      return typed<Awaited<ReturnType<ContainerCheckPort["observe"]>>>({ status: "owned", id: exec, running, exitCode: running ? null : exit });
    } catch { return typed<Awaited<ReturnType<ContainerCheckPort["observe"]>>>({ status: "unavailable" }); }
  };
  return Object.freeze(typed<ContainerCheckPort & CheckTargetPort>({
    select: async (requested, expected, task) => {
      const action = parseManagedServiceAction(requested); if (!action.ok || !validNativeVersion(expected) || !taskId(task)) return Object.freeze({ status: "foreign" as const });
      const version = Object.freeze({ id: expected.id, version: expected.version });
      try {
        const reply = await api.request("GET", `/tasks/${task}`); if (reply.status === 404) return Object.freeze({ status: "absent" as const }); if (reply.status !== 200) return Object.freeze({ status: "unavailable" as const });
        const container = nativeField(nativeField(nativeField(reply.value, "Status"), "ContainerStatus"), "ContainerID"); const target = parseCheckTarget({ action: action.value, service: version.id, task, container }); if (!target.ok) return Object.freeze({ status: "foreign" as const });
        const status = await current(target.value); if (status !== "owned") return Object.freeze({ status }); const service = await api.request("GET", `/services/${version.id}`);
        const observedVersion = nativeField(nativeField(service.value, "Version"), "Index"); if (service.status !== 200 || typeof observedVersion !== "number" || !Number.isSafeInteger(observedVersion) || observedVersion < version.version) return Object.freeze({ status: "unavailable" as const });
        return Object.freeze({ status: "owned" as const, target: target.value });
      } catch { return Object.freeze({ status: "unavailable" as const }); }
    },
    create: async (input) => {
      const checked = parseContainerCheckPlan(input); if (!checked.ok) return Object.freeze({ status: "refused" as const }); const plan = checked.value;
      try {
        const left = plan.deadline - now(); if (!Number.isSafeInteger(left) || left <= 0) return Object.freeze({ status: "refused" as const }); if (await current(plan.target, Math.min(10_000, left)) !== "owned") return Object.freeze({ status: "refused" as const });
        const remaining = plan.deadline - now(); if (remaining <= 0) return Object.freeze({ status: "refused" as const });
        const reply = await api.request("POST", `/containers/${plan.target.container}/exec`, { AttachStdin: false, AttachStdout: false, AttachStderr: false, Tty: false, Privileged: false, Cmd: plan.command, Env: [`KAYRA_OPERATION_ID=${plan.run}:check:${plan.check}`] }, { timeoutMs: Math.min(10_000, remaining) });
        const exec = nativeField(reply.value, "Id"); return reply.status === 201 && id(exec) ? Object.freeze({ status: "created" as const, id: exec }) : Object.freeze({ status: "uncertain" as const });
      } catch { return Object.freeze({ status: "uncertain" as const }); }
    },
    start: async (input, exec, deadline) => {
      const checked = parseContainerCheckPlan(input); if (!checked.ok || !id(exec) || !Number.isSafeInteger(deadline) || deadline > checked.value.deadline) return "refused";
      const plan = checked.value;
      try {
        const left = deadline - now(); if (left <= 0 || left > plan.timeoutSeconds * 1000) return "refused";
        if (await current(plan.target, Math.min(10_000, left)) !== "owned") return "refused";
        const observed = await observe(plan, exec); if (observed.status !== "owned" || observed.running) return "refused";
        const remaining = deadline - now(); if (remaining <= 0) return "refused";
        const reply = await api.request("POST", `/exec/${exec}/start`, { Detach: true, Tty: false }, { timeoutMs: Math.min(10_000, remaining) }); return reply.status === 200 ? "acknowledged" : "uncertain";
      } catch { return "uncertain"; }
    },
    observe,
  }));
};
