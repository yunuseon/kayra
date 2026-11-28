/* Parser temporaries are frozen before crossing the contract boundary. */
import { z } from "zod";
import { err, ok } from "../lib/result.ts";
import type { ApplicationPlan } from "./http-plan.ts";
import { parseRegistrationGeneration } from "./registration-generation.ts";
import { parseRollout, validateAdmission } from "./rollout.ts";
import { admitSwarmGrants, parseSwarmAuthority, parseSwarmGrants } from "./swarm-authority.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const seconds = positive.max(300);
const text = z.string().max(65536).refine((value) => !value.includes("\0"));
const key = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const serviceName = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
const binding = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: text }).strict(),
  z.object({ kind: z.literal("configuration"), key }).strict(),
  z.object({ kind: z.literal("secret"), key }).strict(),
]);
const argument = z.string().max(4096).refine((value) => !value.includes("\0") && !value.includes("$"));
const words = z.array(argument).min(1).max(128).refine((value) => value[0] !== "");
const service = z.object({
  image: z.string(), environment: z.record(key, binding), command: words.nullable(), entrypoint: words.nullable(),
  resources: z.object({ memoryBytes: positive, reserveMemoryBytes: positive, nanoCpus: positive, reserveNanoCpus: positive }).strict(),
  health: z.object({ command: words, intervalSeconds: seconds, timeoutSeconds: seconds,
    startPeriodSeconds: z.number().int().min(0).max(300), retries: positive.max(100) }).strict(),
  stopGraceSeconds: seconds,
}).strict();
const path = z.string().max(2048).regex(/^\/[a-zA-Z0-9_./%~-]*$/);
const schema = z.object({
  version: z.literal(1), runtime: z.literal("swarm"), app: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  registration: z.unknown(), commit: z.string().regex(/^[0-9a-f]{40}$/), artifact: z.string().regex(/^[0-9a-f]{64}$/),
  host: z.unknown(), grants: z.unknown(), configurationIdentity: z.string().regex(/^sha256:[0-9a-f]{64}$/), rollout: z.unknown(),
  policy: z.object({ version: z.literal(1), failureMonitorSeconds: z.literal(30), updateTimeoutSeconds: z.literal(90), rollbackTimeoutSeconds: z.literal(90) }).strict(),
  services: z.record(serviceName, service),
  routes: z.array(z.object({ host: z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/), path: path.nullable(), service: serviceName,
    port: positive.max(65535), check: path,
    rateLimit: z.object({ average: positive, period: z.string().regex(/^[1-9][0-9]*(?:ms|s|m|h)$/), burst: positive }).strict().nullable(),
  }).strict()).length(1),
}).strict();
const freeze = (value: unknown): void => { if (typeof value === "object" && value !== null) { Object.values(value).forEach(freeze); Object.freeze(value); } };

/** First native HTTP subset; persisted plans are validated again before effects. */
export const parseApplicationPlan = (input: unknown) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err("invalid immutable HTTP plan");
  const value = parsed.data;
  const registration = parseRegistrationGeneration(value.registration);
  const host = parseSwarmAuthority(value.host);
  const grants = parseSwarmGrants(value.grants);
  const rollout = parseRollout(value.rollout);
  if (!registration.ok || !host.ok || !grants.ok || !rollout.ok || registration.value.app !== value.app || !admitSwarmGrants(host.value, grants.value).ok) return err("invalid immutable plan authority");
  const names = Object.keys(value.services);
  const name = names[0];
  const route = value.routes[0];
  const item = name === undefined ? undefined : value.services[name];
  const admitted = validateAdmission({ runtime: "swarm", existingRuntime: "swarm", swarmEnabled: true, maintenanceGranted: grants.value.maintenance,
    capabilities: ["rolling-http"], rollout: rollout.value, composeServices: names, routedServices: value.routes.map((route) => route.service),
    migrationTimeoutCeilingSeconds: 90, checkTimeoutCeilingSeconds: 90 });
  if (!admitted.ok || names.length !== 1 || name === undefined || item === undefined || rollout.value.strategy !== "rolling" || rollout.value.services[name]?.role !== "http" ||
    route?.service !== name || `kayra-${value.app}--${name}`.length > 63) return err("unsupported immutable HTTP plan");
  const component = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
  const image = new RegExp(`^localhost:5000/${value.app}/${component}(?:/${component})*@sha256:[0-9a-f]{64}$`);
  const resources = item.resources;
  if (item.health.timeoutSeconds > item.health.intervalSeconds || !image.test(item.image) || resources.reserveMemoryBytes > resources.memoryBytes || resources.reserveNanoCpus > resources.nanoCpus ||
    resources.memoryBytes > grants.value.memory_bytes || Math.ceil(resources.nanoCpus / 1_000_000) > grants.value.cpu_millicores) return err("invalid immutable workload resources or image");
  const snapshot = { ...value, registration: registration.value, host: host.value, grants: grants.value, rollout: rollout.value };
  freeze(snapshot);
  return ok<ApplicationPlan>(snapshot);
};
