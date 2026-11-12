/* Adapter-owned Docker temporaries never cross the observation boundary. */
/* eslint-disable functional/prefer-immutable-types */
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseApplicationPlan } from "../../contracts/application-plan.ts";
import type { ApplicationPlan } from "../../contracts/http-plan.ts";
import type { ServiceScope, ServiceAction, ServiceVersion, ServiceWrite, ServiceObservation, SwarmServicePort } from "../../contracts/swarm-service.ts";
import { typed } from "../../lib/typed.ts";
import { dockerApi } from "./docker-api.ts";

const scopeSchema = z.object({ app: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), service: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/), incarnation: z.uuid() }).strict();
const effectSchema = z.enum(["apply", "restore", "fence", "remove", "scrub"]);
const actionSchema = scopeSchema.extend({ action: z.string().max(80), plan: z.string().regex(/^[0-9a-f]{64}$/), deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), effect: effectSchema });
const versionSchema = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const record = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, name: string): unknown => record(value) ? value[name] : undefined;
const reference = (value: unknown, pattern: RegExp) => typeof value === "string" && pattern.test(value) ? value : null;
const effectReference = (value: unknown) => { const parsed = effectSchema.safeParse(value); return parsed.success ? parsed.data : null; };
const planReference = (value: unknown) => reference(value, /^[0-9a-f]{64}$/);
const actionReference = (value: unknown) => reference(value, /^[0-9a-f-]{36}:[1-9][0-9]*(?::(?:apply|restore|fence|remove|scrub):[1-8])?$/);
const states = new Set(["new", "allocated", "pending", "assigned", "accepted", "preparing", "ready", "starting", "running", "complete", "shutdown", "failed", "rejected", "remove", "orphaned"]);
// Docker adds defaults. Compare every field Kayra supplies, retaining exact arrays.
const matches = (observed: unknown, expected: unknown): boolean => {
  if (Array.isArray(expected)) return Array.isArray(observed) && expected.length === observed.length && expected.every((value: unknown, index) => matches(observed[index], value));
  if (record(expected)) return record(observed) && Object.entries(expected).every(([key, value]) => matches(observed[key], value));
  return observed === expected || (observed === undefined && expected === 0);
};
const emptyDefault = (value: unknown): boolean => value === undefined || value === null || value === false || value === 0 || value === "" ||
  (Array.isArray(value) && value.length === 0) || (record(value) && Object.values(value).every(emptyDefault));
const exactLabels = (actual: unknown, expected: unknown) => record(actual) && record(expected) && Object.keys(actual).length === Object.keys(expected).length && matches(actual, expected);
const effectiveLabels = (value: unknown) => record(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !["com.kayra.action", "com.kayra.plan", "com.kayra.effect"].includes(key))) : undefined;
const matchesSpec = (actual: unknown, expected: unknown) => {
  if (!record(actual) || !record(expected) || !matches({ ...actual, Labels: effectiveLabels(field(actual, "Labels")) }, { ...expected, Labels: effectiveLabels(field(expected, "Labels")) }) ||
    !exactLabels(effectiveLabels(field(actual, "Labels")), effectiveLabels(field(expected, "Labels")))) return false;
  const container = field(field(actual, "TaskTemplate"), "ContainerSpec");
  const desired = field(field(expected, "TaskTemplate"), "ContainerSpec");
  if (!exactLabels(field(container, "Labels"), field(desired, "Labels"))) return false;
  if (["Mounts", "Secrets", "Configs", "Privileges", "User", "Groups", "Dir", "Hostname", "Hosts", "DNSConfig", "Sysctls", "CapabilityAdd", "CapabilityDrop", "Ulimits", "StopSignal", "ReadOnly", "Init"].some((key) => !emptyDefault(field(container, key)))) return false;
  if (["Command", "Args"].some((key) => field(desired, key) === undefined && !emptyDefault(field(container, key)))) return false;
  const isolation = field(container, "Isolation");
  return (emptyDefault(isolation) || isolation === "default") && emptyDefault(field(field(actual, "EndpointSpec"), "Ports"));
};
const nativeName = (scope: ServiceScope) => `kayra-${scope.app}--${scope.service}`;
const prefix = "com.kayra.";
const ownership = (scope: ServiceScope) => ({ [prefix + "app"]: scope.app, [prefix + "service"]: scope.service, [prefix + "incarnation"]: scope.incarnation });
const labelsFor = (action: ServiceAction) => ({ ...ownership(action), [prefix + "action"]: action.action, [prefix + "plan"]: action.plan, [prefix + "effect"]: action.effect });
const owned = (service: unknown, scope: ServiceScope) => {
  const spec = field(service, "Spec");
  const labels = field(spec, "Labels");
  return field(spec, "Name") === nativeName(scope) && Object.entries(ownership(scope)).every(([key, value]) => field(labels, key) === value);
};
const validAction = (input: ServiceAction) => {
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success || !new RegExp(`^${parsed.data.incarnation}:[1-9][0-9]*(?::${parsed.data.effect}:[1-8])?$`).test(parsed.data.action) || !Number.isSafeInteger(Number(parsed.data.action.split(":")[1])) || nativeName(parsed.data).length > 63) return undefined;
  return Object.freeze(parsed.data);
};

/** Materialized environment stays in the adapter request only, never its result or durable intent. */
export const renderNativeHttp = (input: ApplicationPlan, requested: ServiceAction, environment: Readonly<Record<string, string>>, routing: Readonly<Record<string, string>>) => {
  const parsed = parseApplicationPlan(input);
  const action = validAction(requested);
  if (!parsed.ok || action === undefined) throw new Error("invalid native HTTP intent");
  const plan = parsed.value;
  const service = plan.services[action.service];
  if (plan.app !== action.app || plan.registration.incarnation !== action.incarnation || service === undefined || createHash("sha256").update(JSON.stringify(plan)).digest("hex") !== action.plan) throw new Error("native HTTP intent does not match immutable plan");
  const names = Object.keys(service.environment);
  if (Object.keys(environment).length !== names.length || names.some((key) => typeof environment[key] !== "string" || environment[key].includes("\0") || environment[key].length > 65536 || (service.environment[key]?.kind === "literal" && service.environment[key].value !== environment[key]))) throw new Error("invalid materialized environment");
  if (Object.entries(routing).some(([key, value]) => !key.startsWith("traefik.") || typeof value !== "string")) throw new Error("invalid platform routing policy");
  const health = service.health;
  return {
    Name: nativeName(action), Labels: { ...routing, ...labelsFor(action) },
    TaskTemplate: {
      ContainerSpec: { Image: service.image, Labels: labelsFor(action), Env: names.toSorted().map((key) => `${key}=${environment[key] ?? ""}`),
        ...(service.command === null ? {} : { Args: service.command }), ...(service.entrypoint === null ? {} : { Command: service.entrypoint }),
        Healthcheck: { Test: ["CMD", ...health.command], Interval: health.intervalSeconds * 1e9, Timeout: health.timeoutSeconds * 1e9, StartPeriod: health.startPeriodSeconds * 1e9, Retries: health.retries }, StopGracePeriod: service.stopGraceSeconds * 1e9 },
      Resources: { Limits: { MemoryBytes: service.resources.memoryBytes, NanoCPUs: service.resources.nanoCpus }, Reservations: { MemoryBytes: service.resources.reserveMemoryBytes, NanoCPUs: service.resources.reserveNanoCpus } },
      Placement: { Constraints: [`node.id==${plan.host.node}`] }, RestartPolicy: { Condition: "any", Delay: 1e9 }, Networks: [{ Target: plan.host.network.id }],
    },
    Mode: { Replicated: { Replicas: 1 } }, EndpointSpec: { Mode: "vip" },
    UpdateConfig: { Parallelism: 1, Order: "start-first", Monitor: plan.policy.failureMonitorSeconds * 1e9, FailureAction: action.effect === "restore" ? "pause" : "rollback", MaxFailureRatio: 0 },
    RollbackConfig: { Parallelism: 1, Order: "start-first", Monitor: plan.policy.failureMonitorSeconds * 1e9, FailureAction: "pause", MaxFailureRatio: 0 },
  };
};

/** No journal, retries, deadline renewal, release selection or DELETE service operation. */
export const swarmService = (api = dockerApi(), now: () => number = Date.now) => {
  const getOwned = async (scope: ServiceScope, identity = nativeName(scope), timeoutMs = 10_000) => {
    const reply = await api.request("GET", `/services/${encodeURIComponent(identity)}`, undefined, { timeoutMs });
    if (reply.status === 404) return { status: "absent" as const };
    if (reply.status !== 200 || !record(reply.value)) return { status: "unavailable" as const };
    if (!owned(reply.value, scope)) return { status: "foreign" as const };
    return { status: "owned" as const, value: reply.value };
  };
  const observe = async (input: ServiceScope, expectedSpec?: unknown): Promise<ServiceObservation> => {
    const scope = scopeSchema.safeParse(input);
    if (!scope.success || nativeName(scope.data).length > 63) return { status: "foreign" };
    try {
      const service = await getOwned(scope.data);
      if (service.status !== "owned") return service;
      const id = field(service.value, "ID");
      const version = field(field(service.value, "Version"), "Index");
      const spec = field(service.value, "Spec");
      const labels = field(spec, "Labels");
      const taskLabels = field(field(field(spec, "TaskTemplate"), "ContainerSpec"), "Labels");
      const replicas = field(field(field(spec, "Mode"), "Replicated"), "Replicas");
      const endpoint = field(field(spec, "EndpointSpec"), "Mode");
      if (typeof id !== "string" || !versionSchema.safeParse({ id, version }).success || typeof version !== "number" || typeof replicas !== "number" || !Number.isSafeInteger(replicas) || replicas < 0 || (endpoint !== "vip" && endpoint !== "dnsrr")) return { status: "unavailable" };
      const reply = await api.request("GET", `/tasks?filters=${encodeURIComponent(JSON.stringify({ service: [id] }))}`);
      if (reply.status !== 200 || !Array.isArray(reply.value)) return { status: "unavailable" };
      const tasks = await Promise.all(reply.value.map(async (task: unknown) => {
        const taskId = field(task, "ID");
        const desired = field(task, "DesiredState");
        const status = field(task, "Status");
        const state = field(status, "State");
        const labels = field(field(field(task, "Spec"), "ContainerSpec"), "Labels");
        if (typeof taskId !== "string" || !/^[a-z0-9]{25}$/.test(taskId) || typeof desired !== "string" || !states.has(desired) || typeof state !== "string" || !states.has(state) || field(task, "ServiceID") !== id || !Object.entries({ [prefix + "app"]: scope.data.app, [prefix + "service"]: scope.data.service }).every(([key, value]) => field(labels, key) === value) || !z.uuid().safeParse(field(labels, prefix + "incarnation")).success) throw new Error("invalid owned task observation");
        const container = field(field(status, "ContainerStatus"), "ContainerID");
        const health = desired === "running" && state === "running" && typeof container === "string"
          ? await api.request("GET", `/containers/${encodeURIComponent(container)}/json`) : undefined;
        const healthState = health?.status === 200 ? field(field(field(health.value, "State"), "Health"), "Status") : undefined;
        return Object.freeze({ id: taskId, effect: effectReference(field(labels, prefix + "effect")), incarnation: String(field(labels, prefix + "incarnation")), desired, state, plan: planReference(field(labels, prefix + "plan")), action: actionReference(field(labels, prefix + "action")),
          health: typed<"healthy" | "unhealthy" | "starting" | "absent" | "unknown">(health === undefined ? "absent" : healthState === "healthy" || healthState === "unhealthy" || healthState === "starting" ? healthState : "unknown") });
      }));
      const empty = (value: unknown) => value === undefined || value === null || (Array.isArray(value) && value.length === 0);
      const noInputs = (specification: unknown) => {
        const template = field(specification, "TaskTemplate");
        const container = field(template, "ContainerSpec");
        return ["Env", "Secrets", "Configs", "Mounts"].every((key) => empty(field(container, key))) && empty(field(template, "Networks"));
      };
      const retainedInputsCleared = field(labels, prefix + "tombstone") === "true" && noInputs(spec) && noInputs(field(service.value, "PreviousSpec")) && empty(field(field(service.value, "Endpoint"), "VirtualIPs"));
      return Object.freeze({ status: "owned", id, version, replicas, endpoint, action: actionReference(field(labels, prefix + "action")), plan: planReference(field(labels, prefix + "plan")), taskPlan: planReference(field(taskLabels, prefix + "plan")),
        effect: effectReference(field(labels, prefix + "effect")), taskEffect: effectReference(field(taskLabels, prefix + "effect")), tombstone: field(labels, prefix + "tombstone") === "true", retainedInputsCleared, specMatches: expectedSpec === undefined ? null : matchesSpec(spec, expectedSpec), update: reference(field(field(service.value, "UpdateStatus"), "State"), /^(?:updating|paused|completed|rollback_started|rollback_paused|rollback_completed)$/), tasks: Object.freeze(tasks) });
    } catch { return { status: "unavailable" }; }
  };
  const replace = async (action: ServiceAction, expected: ServiceVersion | null, spec: unknown): Promise<ServiceWrite> => {
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
  return typed<SwarmServicePort>(Object.freeze({
    observe: (scope) => observe(scope),
    observeDesired: async (action, plan, environment, routing) => {
      try { return await observe({ app: action.app, service: action.service, incarnation: action.incarnation }, renderNativeHttp(plan, action, environment, routing)); }
      catch { return { status: "unavailable" }; }
    },
    apply: async (requested: ServiceAction, expected: ServiceVersion | null, plan: ApplicationPlan, environment: Readonly<Record<string, string>>, routing: Readonly<Record<string, string>>): Promise<ServiceWrite> => {
      const action = validAction(requested);
      if (action === undefined || (action.effect !== "apply" && action.effect !== "restore") || (expected !== null && !versionSchema.safeParse(expected).success)) return "refused";
      try { return await replace(action, expected, renderNativeHttp(plan, action, environment, routing)); }
      catch { return "refused"; }
    },
    fence: async (requested: ServiceAction, expected: ServiceVersion): Promise<ServiceWrite> => {
      const action = validAction(requested);
      if (action?.effect !== "fence" || !versionSchema.safeParse(expected).success) return "refused";
      try {
        const left = action.deadline - now();
        if (left <= 0 || left > 90_000) return "refused";
        const current = await getOwned(action, expected.id, Math.min(10_000, left));
        if (current.status !== "owned") return current.status === "unavailable" ? "uncertain" : "conflict";
        const spec = field(current.value, "Spec");
        if (!record(spec)) return "uncertain";
        const labels = field(spec, "Labels");
        if (!record(labels)) return "uncertain";
        return await replace(action, expected, { ...spec, Labels: { ...labels, [prefix + "action"]: action.action, [prefix + "effect"]: action.effect } });
      } catch { return "uncertain"; }
    },
    tombstone: async (requested: ServiceAction, expected: ServiceVersion | null, image: string): Promise<ServiceWrite> => {
      const action = validAction(requested);
      if (action === undefined || (action.effect !== "remove" && action.effect !== "scrub") || (expected === null ? action.effect === "scrub" : !versionSchema.safeParse(expected).success) || !new RegExp(`^localhost:5000/${action.app}/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$`).test(image) || image.includes("..")) return "refused";
      return replace(action, expected, { Name: nativeName(action), Labels: { ...labelsFor(action), [prefix + "tombstone"]: "true" },
        TaskTemplate: { ContainerSpec: { Image: image, Labels: labelsFor(action) }, RestartPolicy: { Condition: "none" }, Networks: [] },
        Mode: { Replicated: { Replicas: 0 } }, EndpointSpec: { Mode: "dnsrr" } });
    },
  }));
};
