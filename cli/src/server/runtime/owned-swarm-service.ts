/* Adapter-owned Docker objects and buffers never cross the normalized observation boundary. */
/* eslint-disable functional/prefer-immutable-types -- runtime profiles and transport handles are owned by this adapter */
import { z } from "zod";
import type { ServiceScope, ServiceAction, ServiceVersion, ServiceWrite, ServiceObservation } from "../../contracts/swarm-service.ts";
import { typed } from "../../lib/typed.ts";
import { dockerApi } from "./docker-api.ts";

const effectSchema = z.enum(["apply", "restore", "fence", "remove", "scrub"]);
const versionSchema = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const validNativeVersion = (input: unknown) => versionSchema.safeParse(input).success;
type Profile<S extends ServiceScope, A extends ServiceAction & S> = {
  readonly scope: (input: unknown) => S | undefined;
  readonly action: (input: unknown) => A | undefined;
  readonly nativeName: (scope: S) => string;
  readonly ownership: (scope: S) => Readonly<Record<string, string>>;
  readonly taskOwned: (scope: S, labels: unknown) => boolean;
  readonly matchesSpec: (actual: unknown, expected: unknown) => boolean;
};
export const nativeRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
export const nativeField = (value: unknown, name: string): unknown => nativeRecord(value) ? value[name] : undefined;
const reference = (value: unknown, pattern: RegExp) => typeof value === "string" && pattern.test(value) ? value : null;
const effectReference = (value: unknown) => { const parsed = effectSchema.safeParse(value); return parsed.success ? parsed.data : null; };
const planReference = (value: unknown) => reference(value, /^[0-9a-f]{64}$/);
const actionReference = (value: unknown) => reference(value, /^[0-9a-f-]{36}:[1-9][0-9]*(?::(?:apply|restore|fence|remove|scrub):[1-8]|:(?:quiesce|recover):(?:remove|scrub):[1-8])?$/);
const states = new Set(["new", "allocated", "pending", "assigned", "accepted", "preparing", "ready", "starting", "running", "complete", "shutdown", "failed", "rejected", "remove", "orphaned"]);
// Docker omits empty arrays or returns null. Nonempty arrays and every supplied field still compare exactly.
const matches = (observed: unknown, expected: unknown): boolean => {
  if (Array.isArray(expected)) return expected.length === 0 && (observed === undefined || observed === null) || Array.isArray(observed) && expected.length === observed.length && expected.every((value: unknown, index) => matches(observed[index], value));
  if (nativeRecord(expected)) return nativeRecord(observed) && Object.entries(expected).every(([key, value]) => matches(observed[key], value));
  return observed === expected || (observed === undefined && expected === 0);
};
const emptyDefault = (value: unknown): boolean => value === undefined || value === null || value === false || value === 0 || value === "" ||
  (Array.isArray(value) && value.length === 0) || (nativeRecord(value) && Object.values(value).every(emptyDefault));
const exactLabels = (actual: unknown, expected: unknown) => nativeRecord(actual) && nativeRecord(expected) && Object.keys(actual).length === Object.keys(expected).length && matches(actual, expected);
const effectiveLabels = (value: unknown) => nativeRecord(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !["com.kayra.action", "com.kayra.plan", "com.kayra.effect"].includes(key))) : undefined;
export const nativeSpecMatches = (actual: unknown, expected: unknown, mounts: (actual: unknown, expected: unknown) => boolean = (actual) => emptyDefault(actual)) => {
  if (!nativeRecord(actual) || !nativeRecord(expected) || !matches({ ...actual, Labels: effectiveLabels(nativeField(actual, "Labels")) }, { ...expected, Labels: effectiveLabels(nativeField(expected, "Labels")) }) ||
    !exactLabels(effectiveLabels(nativeField(actual, "Labels")), effectiveLabels(nativeField(expected, "Labels")))) return false;
  const container = nativeField(nativeField(actual, "TaskTemplate"), "ContainerSpec");
  const desired = nativeField(nativeField(expected, "TaskTemplate"), "ContainerSpec");
  if (!exactLabels(nativeField(container, "Labels"), nativeField(desired, "Labels"))) return false;
  if (["Secrets", "Configs", "Privileges", "User", "Groups", "Dir", "Hostname", "Hosts", "DNSConfig", "Sysctls", "CapabilityAdd", "CapabilityDrop", "Ulimits", "StopSignal", "ReadOnly", "Init"].some((key) => !emptyDefault(nativeField(container, key)))) return false;
  if (!mounts(nativeField(container, "Mounts"), nativeField(desired, "Mounts"))) return false;
  if (["Command", "Args"].some((key) => nativeField(desired, key) === undefined && !emptyDefault(nativeField(container, key)))) return false;
  const isolation = nativeField(container, "Isolation");
  return (emptyDefault(isolation) || isolation === "default") && emptyDefault(nativeField(nativeField(actual, "EndpointSpec"), "Ports"));
};

/** Runtime-internal primitive only. Public adapters accept validated typed plans, never arbitrary native specs. */
export const ownedSwarmService = <S extends ServiceScope, A extends ServiceAction & S>(profile: Profile<S, A>, api = dockerApi(), now: () => number = Date.now) => {
  const prefix = "com.kayra.";
  const nativeName = profile.nativeName;
  const labelsFor = (action: A) => ({ ...profile.ownership(action), [prefix + "action"]: action.action, [prefix + "plan"]: action.plan, [prefix + "effect"]: action.effect });
  const owned = (service: unknown, scope: S) => nativeField(nativeField(service, "Spec"), "Name") === nativeName(scope) && Object.entries(profile.ownership(scope)).every(([key, value]) => nativeField(nativeField(nativeField(service, "Spec"), "Labels"), key) === value);
  const getOwned = async (scope: S, identity = nativeName(scope), timeoutMs = 10_000) => {
    const reply = await api.request("GET", `/services/${encodeURIComponent(identity)}`, undefined, { timeoutMs });
    if (reply.status === 404) return { status: "absent" as const };
    if (reply.status !== 200 || !nativeRecord(reply.value)) return { status: "unavailable" as const };
    if (!owned(reply.value, scope)) return { status: "foreign" as const };
    return { status: "owned" as const, value: reply.value };
  };
  const observe = async (input: unknown, expectedSpec?: unknown): Promise<ServiceObservation> => {
    const scope = profile.scope(input);
    if (scope === undefined || nativeName(scope).length > 63) return { status: "foreign" };
    try {
      const service = await getOwned(scope);
      if (service.status !== "owned") return service;
      const id = nativeField(service.value, "ID");
      const version = nativeField(nativeField(service.value, "Version"), "Index");
      const spec = nativeField(service.value, "Spec");
      const labels = nativeField(spec, "Labels");
      const taskLabels = nativeField(nativeField(nativeField(spec, "TaskTemplate"), "ContainerSpec"), "Labels");
      const replicas = nativeField(nativeField(nativeField(spec, "Mode"), "Replicated"), "Replicas");
      const endpoint = nativeField(nativeField(spec, "EndpointSpec"), "Mode");
      if (typeof id !== "string" || !versionSchema.safeParse({ id, version }).success || typeof version !== "number" || typeof replicas !== "number" || !Number.isSafeInteger(replicas) || replicas < 0 || (endpoint !== "vip" && endpoint !== "dnsrr")) return { status: "unavailable" };
      const reply = await api.request("GET", `/tasks?filters=${encodeURIComponent(JSON.stringify({ service: [id] }))}`);
      if (reply.status !== 200 || !Array.isArray(reply.value)) return { status: "unavailable" };
      const tasks = await Promise.all(reply.value.map(async (task: unknown) => {
        const taskId = nativeField(task, "ID");
        const desired = nativeField(task, "DesiredState");
        const status = nativeField(task, "Status");
        const state = nativeField(status, "State");
        const labels = nativeField(nativeField(nativeField(task, "Spec"), "ContainerSpec"), "Labels");
        if (typeof taskId !== "string" || !/^[a-z0-9]{25}$/.test(taskId) || typeof desired !== "string" || !states.has(desired) || typeof state !== "string" || !states.has(state) || nativeField(task, "ServiceID") !== id || !profile.taskOwned(scope, labels)) throw new Error("invalid owned task observation");
        const container = nativeField(nativeField(status, "ContainerStatus"), "ContainerID");
        const health = desired === "running" && state === "running" && typeof container === "string"
          ? await api.request("GET", `/containers/${encodeURIComponent(container)}/json`) : undefined;
        const healthState = health?.status === 200 ? nativeField(nativeField(nativeField(health.value, "State"), "Health"), "Status") : undefined;
        return Object.freeze({ id: taskId, effect: effectReference(nativeField(labels, prefix + "effect")), incarnation: String(nativeField(labels, prefix + "incarnation")), desired, state, plan: planReference(nativeField(labels, prefix + "plan")), action: actionReference(nativeField(labels, prefix + "action")),
          health: typed<"healthy" | "unhealthy" | "starting" | "absent" | "unknown">(health === undefined ? "absent" : healthState === "healthy" || healthState === "unhealthy" || healthState === "starting" ? healthState : "unknown") });
      }));
      // Task status can precede actual container cessation; include containers absent from task history.
      const containers = await api.request("GET", `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`com.docker.swarm.service.id=${id}`] }))}`);
      if (containers.status !== 200 || !Array.isArray(containers.value)) return { status: "unavailable" };
      const rows = containers.value.map((container: unknown) => {
        const labels = nativeField(container, "Labels"); const containerId = nativeField(container, "Id");
        if (typeof containerId !== "string" || !/^[a-f0-9]{64}$/.test(containerId) || nativeField(labels, "com.docker.swarm.service.id") !== id || !profile.taskOwned(scope, labels)) throw new Error("invalid owned container observation");
        return Object.freeze({ id: containerId, state: nativeField(container, "State"), labels });
      });
      const running = reply.value.filter((task: unknown) => nativeField(task, "DesiredState") === "running" && nativeField(nativeField(task, "Status"), "State") === "running");
      const matchesTask = (container: typeof rows[number], task: unknown) => {
        const labels = nativeField(nativeField(nativeField(task, "Spec"), "ContainerSpec"), "Labels");
        return container.state === "running" && container.id === nativeField(nativeField(nativeField(task, "Status"), "ContainerStatus"), "ContainerID") && nativeField(container.labels, "com.docker.swarm.task.id") === nativeField(task, "ID") &&
          ["action", "plan", "effect"].every((key) => nativeField(container.labels, prefix + key) === nativeField(labels, prefix + key));
      };
      const stopped = (container: typeof rows[number]) => container.state === "exited" || container.state === "dead";
      const containersStopped = replicas === 0 && rows.every(stopped);
      const containersConverged = rows.every((container) => stopped(container) || running.some((task: unknown) => matchesTask(container, task))) && running.every((task: unknown) => rows.some((container) => matchesTask(container, task)));
      const empty = (value: unknown) => value === undefined || value === null || (Array.isArray(value) && value.length === 0);
      const noInputs = (specification: unknown) => {
        const template = nativeField(specification, "TaskTemplate");
        const container = nativeField(template, "ContainerSpec");
        return ["Env", "Secrets", "Configs", "Mounts"].every((key) => empty(nativeField(container, key))) && empty(nativeField(template, "Networks"));
      };
      const update = nativeField(nativeField(service.value, "UpdateStatus"), "State");
      const retainedInputsCleared = nativeField(labels, prefix + "tombstone") === "true" && noInputs(spec) && noInputs(nativeField(service.value, "PreviousSpec")) && empty(nativeField(nativeField(service.value, "Endpoint"), "VirtualIPs"));
      return Object.freeze({ status: "owned", id, version, replicas, endpoint, action: actionReference(nativeField(labels, prefix + "action")), plan: planReference(nativeField(labels, prefix + "plan")), taskPlan: planReference(nativeField(taskLabels, prefix + "plan")),
        effect: effectReference(nativeField(labels, prefix + "effect")), taskEffect: effectReference(nativeField(taskLabels, prefix + "effect")), tombstone: nativeField(labels, prefix + "tombstone") === "true", retainedInputsCleared, containersStopped, containersConverged, specMatches: expectedSpec === undefined ? null : profile.matchesSpec(spec, expectedSpec), update: update === undefined || update === null ? null : reference(update, /^(?:updating|paused|completed|rollback_started|rollback_paused|rollback_completed)$/) ?? "unknown", tasks: Object.freeze(tasks) });
    } catch { return { status: "unavailable" }; }
  };
  const replace = async (action: A, expected: ServiceVersion | null, spec: unknown): Promise<ServiceWrite> => {
    if (profile.action(action) === undefined || expected !== null && !validNativeVersion(expected)) return "refused";
    try {
      const remaining = action.deadline - now();
      if (!Number.isSafeInteger(remaining) || remaining <= 0 || remaining > 90_000) return "refused";
      const current = await getOwned(action, expected?.id, Math.min(10_000, remaining));
      if (expected === null ? current.status !== "absent" : current.status !== "owned") return current.status === "unavailable" ? "uncertain" : "conflict";
      // Always use the recorded version. A read never rebases an interrupted write.
      const left = action.deadline - now();
      if (!Number.isSafeInteger(left) || left <= 0) return "refused";
      const reply = await api.request("POST", expected === null ? "/services/create" : `/services/${expected.id}/update?version=${String(expected.version)}`, spec, { timeoutMs: Math.min(10_000, left) });
      return reply.status === (expected === null ? 201 : 200) ? "acknowledged" : "uncertain";
    } catch { return "uncertain"; }
  };
  return Object.freeze({ observe, replace,
    fence: async (requested: A, expected: ServiceVersion): Promise<ServiceWrite> => {
      const action = profile.action(requested);
      if (action?.effect !== "fence" || !validNativeVersion(expected)) return "refused";
      try {
        const left = action.deadline - now();
        if (left <= 0 || left > 90_000) return "refused";
        const current = await getOwned(action, expected.id, Math.min(10_000, left));
        if (current.status !== "owned") return current.status === "unavailable" ? "uncertain" : "conflict";
        const spec = nativeField(current.value, "Spec");
        if (!nativeRecord(spec)) return "uncertain";
        const labels = nativeField(spec, "Labels");
        if (!nativeRecord(labels)) return "uncertain";
        return await replace(action, expected, { ...spec, Labels: { ...labels, [prefix + "action"]: action.action, [prefix + "effect"]: action.effect } });
      } catch { return "uncertain"; }
    },
    tombstone: async (requested: A, expected: ServiceVersion | null, image: string): Promise<ServiceWrite> => {
      const action = profile.action(requested);
      if (action === undefined || (action.effect !== "remove" && action.effect !== "scrub") || (expected === null ? action.effect === "scrub" : !validNativeVersion(expected)) || !new RegExp(`^localhost:5000/${action.app}/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$`).test(image) || image.includes("..")) return "refused";
      return replace(action, expected, { Name: nativeName(action), Labels: { ...labelsFor(action), [prefix + "tombstone"]: "true" },
        TaskTemplate: { ContainerSpec: { Image: image, Labels: labelsFor(action) }, RestartPolicy: { Condition: "none" }, Networks: [] },
        Mode: { Replicated: { Replicas: 0 } }, EndpointSpec: { Mode: "dnsrr" } });
    },
  });
};
