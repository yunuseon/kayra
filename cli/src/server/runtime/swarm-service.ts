import { ownedSwarmService, nativeField, nativeSpecMatches } from "./owned-swarm-service.ts";
/* Adapter-owned Docker temporaries never cross the observation boundary. */
/* eslint-disable functional/prefer-immutable-types */
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseApplicationPlan } from "../../contracts/application-plan.ts";
import type { ApplicationPlan } from "../../contracts/http-plan.ts";
import type { ServiceScope, ServiceAction, SwarmServicePort } from "../../contracts/swarm-service.ts";
import { typed } from "../../lib/typed.ts";
import { dockerApi } from "./docker-api.ts";

const scopeSchema = z.object({ app: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), service: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/), incarnation: z.uuid() }).strict();
const effectSchema = z.enum(["apply", "restore", "fence", "remove", "scrub"]);
const actionSchema = scopeSchema.extend({ action: z.string().max(80), plan: z.string().regex(/^[0-9a-f]{64}$/), deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), effect: effectSchema });
const versionSchema = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const nativeName = (scope: ServiceScope) => `kayra-${scope.app}--${scope.service}`;
const prefix = "com.kayra.";
const ownership = (scope: ServiceScope) => ({ [prefix + "app"]: scope.app, [prefix + "service"]: scope.service, [prefix + "incarnation"]: scope.incarnation });
const labelsFor = (action: ServiceAction) => ({ ...ownership(action), [prefix + "action"]: action.action, [prefix + "plan"]: action.plan, [prefix + "effect"]: action.effect });
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
  const native = ownedSwarmService<ServiceScope, ServiceAction>({
    scope: (input) => { const parsed = scopeSchema.safeParse(input); return parsed.success ? parsed.data : undefined; },
    action: (input) => { const parsed = actionSchema.safeParse(input); return parsed.success ? validAction(parsed.data) : undefined; },
    nativeName, ownership, matchesSpec: nativeSpecMatches,
    taskOwned: (scope, labels) => Object.entries({ [prefix + "app"]: scope.app, [prefix + "service"]: scope.service }).every(([key, value]) => nativeField(labels, key) === value) && z.uuid().safeParse(nativeField(labels, prefix + "incarnation")).success,
  }, api, now);
  return typed<SwarmServicePort>(Object.freeze({
    observe: (scope) => native.observe(scope),
    observeDesired: async (action, plan, environment, routing) => {
      try { return await native.observe({ app: action.app, service: action.service, incarnation: action.incarnation }, renderNativeHttp(plan, action, environment, routing)); }
      catch { return { status: "unavailable" }; }
    },
    apply: async (requested, expected, plan, environment, routing) => {
      const action = validAction(requested);
      if (action === undefined || (action.effect !== "apply" && action.effect !== "restore") || (expected !== null && !versionSchema.safeParse(expected).success)) return "refused";
      try { return await native.replace(action, expected, renderNativeHttp(plan, action, environment, routing)); }
      catch { return "refused"; }
    },
    fence: native.fence,
    tombstone: native.tombstone,
  }));
};
