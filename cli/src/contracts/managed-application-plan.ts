import { createHash } from "node:crypto";
import { z } from "zod";
import { parseManagedServicePlan } from "./managed-service-plan.ts";
import { parseRegistrationInfrastructure } from "./registration-infrastructure.ts";
import { parseResolvedImage } from "./image-admission.ts";
import { parseSwarmAuthority, parseSwarmGrants, admitSwarmGrants } from "./swarm-authority.ts";
import { parseRollout, validateAdmission } from "./rollout.ts";
import { matchRegistrationGeneration } from "./registration-generation.ts";
import { all, err, ok } from "../lib/result.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const serviceName = z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const hostName = z.string().max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/);
const path = z.string().max(2048).regex(/^\/[a-zA-Z0-9_./%~-]*$/);
const route = z.object({ host: hostName, path: path.nullable(), service: serviceName, port: positive.max(65535), check: path,
  rateLimit: z.object({ average: positive, period: z.string().regex(/^[1-9][0-9]*(?:ms|s|m|h)$/), burst: positive }).strict().readonly().nullable(),
}).strict().readonly();
const schema = z.object({ version: z.literal(3), runtime: z.literal("swarm"), infrastructure: z.unknown(),
  commit: z.string().regex(/^[a-f0-9]{40}$/), artifact: z.string().regex(/^[a-f0-9]{64}$/), host: z.unknown(), grants: z.unknown(),
  hosts: z.array(hostName).max(128).readonly(), configurationIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/), rollout: z.unknown(),
  policy: z.object({ version: z.literal(1), failureMonitorSeconds: z.literal(30), updateTimeoutSeconds: z.literal(90), rollbackTimeoutSeconds: z.literal(90),
    migrationTimeoutCeilingSeconds: positive.max(86400), checkTimeoutCeilingSeconds: z.literal(90),
  }).strict().readonly(),
  images: z.array(z.unknown()).min(1).max(128).readonly(), services: z.record(serviceName, z.unknown()).refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 32).readonly(),
  routes: z.array(route).max(128).readonly(),
}).strict();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const lexical = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** Format validation only. Available capabilities, image provenance, admission and native evidence are independently established by trusted callers. */
export const parseManagedApplicationPlan = (input: unknown) => {
  const checked = schema.safeParse(input); if (!checked.success) return err("invalid immutable managed application plan"); const value = checked.data;
  const infrastructure = parseRegistrationInfrastructure(value.infrastructure); const host = parseSwarmAuthority(value.host); const grants = parseSwarmGrants(value.grants); const rollout = parseRollout(value.rollout);
  if (!infrastructure.ok || !host.ok || !grants.ok || !rollout.ok) return err("invalid managed application authority or rollout");
  const reference = infrastructure.value; const app = reference.registration.app;
  if (!admitSwarmGrants(host.value, grants.value).ok || reference.overlay.scope.node !== host.value.node || reference.overlay.scope.cluster !== host.value.cluster || reference.overlay.id === host.value.network.id || new Set(value.hosts).size !== value.hosts.length) return err("managed application host or grants disagree");
  const images = all(value.images.map((image) => parseResolvedImage(app, image)));
  const parsedServices = all(Object.entries(value.services).map(([name, spec]) => {
    const parsed = parseManagedServicePlan(spec);
    return parsed.ok && parsed.value.service === name ? ok(Object.freeze({ name, spec: parsed.value })) : err("invalid managed application service");
  }));
  if (!images.ok || !parsedServices.ok) return err("invalid managed application images or services");
  if (new Set(images.value.map((image) => image.source)).size !== images.value.length || new Set(images.value.map((image) => image.architecture)).size !== 1) return err("ambiguous managed image provenance");
  const services = Object.freeze(Object.fromEntries(parsedServices.value.toSorted((left, right) => lexical(left.name, right.name)).map((item) => [item.name, item.spec] as const)));
  const names = Object.keys(services);
  const admitted = validateAdmission({ runtime: "swarm", swarmEnabled: true, existingRuntime: "swarm", maintenanceGranted: grants.value.maintenance,
    capabilities: ["rolling-http", "workers", "singleton", "retained-dependency", "migrations", "checks", "maintenance"], rollout: rollout.value,
    composeServices: names, routedServices: value.routes.map((item) => item.service), migrationTimeoutCeilingSeconds: value.policy.migrationTimeoutCeilingSeconds, checkTimeoutCeilingSeconds: value.policy.checkTimeoutCeilingSeconds,
  });
  if (!admitted.ok) return err(admitted.error);
  if (parsedServices.value.some(({ spec }) => {
    const declaration = rollout.value.services[spec.service];
    return !same(spec.owner, reference.ownership) || spec.host.node !== host.value.node || spec.host.cluster !== host.value.cluster ||
      (spec.role === "http" ? spec.host.routingNetwork !== host.value.network.id : spec.host.routingNetwork !== null) || !same(spec.privateNetwork, { id: reference.overlay.id, name: reference.overlay.scope.name }) ||
      declaration?.role !== spec.role || declaration.overlap !== spec.overlap || (declaration.handoff_check ?? null) !== spec.handoffCheck || !images.value.some((image) => image.pull === spec.image) ||
      spec.role !== "retained-dependency" && (!matchRegistrationGeneration(spec.inputs.registration, reference.registration, reference.registration).ok || spec.inputs.configurationIdentity !== value.configurationIdentity) ||
      spec.dependencies.some((dependency) => services[dependency.service] === undefined || spec.role === "retained-dependency" && services[dependency.service]?.role !== "retained-dependency");
  })) return err("managed service scope, inputs, image or dependencies disagree");
  const acyclic = (remaining: readonly string[]): boolean => {
    if (remaining.length === 0) return true;
    const blocked = remaining.filter((name) => services[name]?.dependencies.some((dependency) => remaining.includes(dependency.service)) ?? true);
    return blocked.length < remaining.length && acyclic(blocked);
  };
  if (!acyclic(names)) return err("managed service dependency cycle");
  const mounts = parsedServices.value.flatMap(({ spec }) => spec.mounts);
  if (mounts.some((mount) => mounts.some((other) => mount.volume.key === other.volume.key && !same(mount.volume, other.volume) || mount.volume.allocation === other.volume.allocation && !same(mount.volume, other.volume)))) return err("managed application volume identities conflict");
  const memory = parsedServices.value.reduce((total, { spec }) => total + spec.resources.memoryBytes, 0);
  const cpu = parsedServices.value.reduce((total, { spec }) => total + spec.resources.nanoCpus, 0);
  if (!Number.isSafeInteger(memory) || !Number.isSafeInteger(cpu) || memory > grants.value.memory_bytes || Math.ceil(cpu / 1_000_000) > grants.value.cpu_millicores) return err("managed steady workloads exceed application grants");
  if (value.routes.some((item) => !value.hosts.includes(item.host)) || new Set(value.routes.map((item) => JSON.stringify([item.host, item.path]))).size !== value.routes.length ||
    parsedServices.value.some(({ spec }) => spec.role === "http" && !value.routes.some((item) => item.service === spec.service))) return err("managed routes are missing, duplicate or outside host grants");
  return ok(Object.freeze({ ...value, infrastructure: reference, host: host.value, grants: grants.value,
    hosts: Object.freeze(value.hosts.toSorted(lexical)), images: Object.freeze(images.value.toSorted((left, right) => lexical(left.source, right.source))),
    services, rollout: Object.freeze({ ...rollout.value, services: Object.freeze(Object.fromEntries(Object.entries(rollout.value.services).toSorted(([left], [right]) => lexical(left, right)))) }),
    routes: Object.freeze(value.routes.toSorted((left, right) => lexical(JSON.stringify([left.host, left.path, left.service]), JSON.stringify([right.host, right.path, right.service])))),
  }));
};
export type ManagedApplicationPlan = Extract<ReturnType<typeof parseManagedApplicationPlan>, { readonly ok: true }>["value"];
export const managedApplicationDigest = (input: ManagedApplicationPlan) => {
  const checked = parseManagedApplicationPlan(input); if (!checked.ok) throw new Error(checked.error);
  return createHash("sha256").update(JSON.stringify(checked.value)).digest("hex");
};
