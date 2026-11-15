/* eslint-disable functional/prefer-immutable-types -- transport and bounded observation handles are adapter-owned */
import { z } from "zod";
import { parseManagedServicePlan, managedServiceName, managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import type { ManagedServicePlan } from "../../contracts/managed-service-plan.ts";
import type { ManagedServiceAction, ManagedServiceInputs, ManagedServiceScope, ManagedSwarmServicePort } from "../../contracts/managed-swarm-service.ts";
import { matchManagedVolumeReceipts, matchManagedVolumeEvidence } from "../../contracts/managed-volume-evidence.ts";
import { volumeMountTargetSchema } from "../../contracts/managed-compose-description.ts";
import { volumeReceiptSchema } from "../../contracts/owned-volume.ts";
import type { OwnedVolumePort } from "../../contracts/owned-volume.ts";
import { typed } from "../../lib/typed.ts";
import { dockerApi } from "./docker-api.ts";
import { ownedVolumes } from "./owned-volume.ts";
import { ownedSwarmService, nativeField, nativeSpecMatches, validNativeVersion } from "./owned-swarm-service.ts";

const scopeSchema = z.object({ app: z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), service: z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), incarnation: z.uuid(), dataOwner: z.uuid() }).strict().readonly().refine((value) => value.incarnation !== value.dataOwner);
const actionSchema = z.object({ app: z.string(), service: z.string(), incarnation: z.uuid(), dataOwner: z.uuid(), action: z.string().max(80), plan: z.string().regex(/^[a-f0-9]{64}$/), deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), effect: z.enum(["apply", "restore", "fence", "remove", "scrub"]) }).strict().readonly();
const scopeOf = (value: ManagedServiceScope) => ({ app: value.app, service: value.service, incarnation: value.incarnation, dataOwner: value.dataOwner });
const parseAction = (input: unknown) => {
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success || !scopeSchema.safeParse(scopeOf(parsed.data)).success || !new RegExp(`^${parsed.data.incarnation}:[1-9][0-9]*(?::${parsed.data.effect}:[1-8])?$`).test(parsed.data.action) || !Number.isSafeInteger(Number(parsed.data.action.split(":")[1]))) return undefined;
  return parsed.data;
};
const nativeName = (scope: ManagedServiceScope) => managedServiceName({ app: scope.app, incarnation: scope.incarnation }, scope.service);
const ownership = (scope: ManagedServiceScope) => ({ "com.kayra.app": scope.app, "com.kayra.service": scope.service, "com.kayra.incarnation": scope.incarnation, "com.kayra.data-owner": scope.dataOwner });
const labelsFor = (action: ManagedServiceAction) => ({ ...ownership(action), "com.kayra.action": action.action, "com.kayra.plan": action.plan, "com.kayra.effect": action.effect });
const nativeMount = z.object({ Type: z.literal("volume"), Source: z.string().regex(/^kayra-data-[0-9a-f-]{36}$/), Target: volumeMountTargetSchema,
  ReadOnly: z.boolean().optional(), Consistency: z.literal("").optional(),
  VolumeOptions: z.object({ NoCopy: z.boolean().optional(), Labels: z.record(z.string(), z.string()).nullable().optional().refine((value) => value === null || value === undefined || Object.keys(value).length === 0), DriverConfig: z.null().optional() }).strict().nullable().optional(),
  BindOptions: z.null().optional(), TmpfsOptions: z.null().optional(),
}).strict();
const mounts = z.array(nativeMount).max(32);
const normalizeMounts = (input: unknown) => {
  const parsed = mounts.safeParse(input ?? []);
  return parsed.success ? parsed.data.map((mount) => Object.freeze({ source: mount.Source, target: mount.Target, readOnly: mount.ReadOnly ?? false, noCopy: mount.VolumeOptions?.NoCopy ?? false })) : undefined;
};
const matchesMounts = (actual: unknown, expected: unknown) => {
  const left = normalizeMounts(actual); const right = normalizeMounts(expected);
  return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
};

const inputsSchema = z.object({
  environment: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), z.string().max(65536).refine((value) => !value.includes("\0"))).refine((value) => Object.keys(value).length <= 128).readonly(),
  routing: z.record(z.string().max(256), z.string().max(4096)).refine((value) => Object.keys(value).length <= 4096).readonly(),
  volumes: z.array(volumeReceiptSchema).max(32).readonly(),
}).strict().readonly();
const prepare = (input: ManagedServicePlan, requested: ManagedServiceAction, supplied: ManagedServiceInputs) => {
  const parsed = parseManagedServicePlan(input); const action = parseAction(requested); const inputs = inputsSchema.safeParse(supplied);
  if (!parsed.ok || action === undefined || !inputs.success) throw new Error("invalid native managed service intent");
  return Object.freeze({ plan: parsed.value, action, inputs: inputs.data });
};

/** Render only validated allocation identities. Fresh creation-instance evidence is required again by the writer. */
const renderPrepared = ({ plan, action, inputs }: ReturnType<typeof prepare>) => {
  if (plan.owner.app !== action.app || plan.owner.incarnation !== action.incarnation || plan.owner.dataOwner !== action.dataOwner || plan.service !== action.service || managedServiceDigest(plan) !== action.plan) throw new Error("native managed intent does not match the immutable plan");
  const bound = matchManagedVolumeReceipts(plan, inputs.volumes); if (!bound.ok) throw new Error("managed volume references are invalid");
  const names = Object.keys(plan.inputs.environment);
  if (Object.keys(inputs.environment).length !== names.length || names.some((key) => typeof inputs.environment[key] !== "string" || inputs.environment[key].includes("\0") || inputs.environment[key].length > 65536 || plan.inputs.environment[key]?.kind === "literal" && plan.inputs.environment[key].value !== inputs.environment[key])) throw new Error("invalid materialized managed environment");
  if (Object.entries(inputs.routing).some(([key, value]) => !key.startsWith("traefik.") || typeof value !== "string") || (plan.role !== "http" && Object.keys(inputs.routing).length !== 0) ||
    plan.role === "http" && (inputs.routing["traefik.enable"] !== "true" || inputs.routing["traefik.swarm.network"] !== "platform-swarm" || inputs.routing["traefik.swarm.lbswarm"] !== "true")) throw new Error("invalid platform managed routing policy");
  const health = plan.health; const order = plan.overlap === "forbidden" ? "stop-first" : "start-first";
  return {
    Name: nativeName(action), Labels: { ...inputs.routing, ...labelsFor(action) },
    TaskTemplate: {
      ContainerSpec: { Image: plan.image, Labels: labelsFor(action), Env: names.toSorted().map((key) => `${key}=${inputs.environment[key] ?? ""}`),
        ...(plan.command === null ? {} : { Args: plan.command }), ...(plan.entrypoint === null ? {} : { Command: plan.entrypoint }),
        ...(plan.mounts.length === 0 ? {} : { Mounts: plan.mounts.map((mount) => ({ Type: "volume", Source: mount.volume.name, Target: mount.target,
          ...(mount.readOnly ? { ReadOnly: true } : {}), ...(mount.noCopy ? { VolumeOptions: { NoCopy: true } } : {}),
        })) }),
        Healthcheck: { Test: ["CMD", ...health.command], Interval: health.intervalSeconds * 1e9, Timeout: health.timeoutSeconds * 1e9, StartPeriod: health.startPeriodSeconds * 1e9, Retries: health.retries }, StopGracePeriod: plan.stopGraceSeconds * 1e9,
      },
      Resources: { Limits: { MemoryBytes: plan.resources.memoryBytes, NanoCPUs: plan.resources.nanoCpus }, Reservations: { MemoryBytes: plan.resources.reserveMemoryBytes, NanoCPUs: plan.resources.reserveNanoCpus } },
      Placement: { Constraints: [`node.id==${plan.host.node}`] }, RestartPolicy: { Condition: "any", Delay: 1e9 },
      Networks: [{ Target: plan.privateNetwork.id, Aliases: [plan.service] }, ...(plan.host.routingNetwork === null ? [] : [{ Target: plan.host.routingNetwork }])],
    },
    Mode: { Replicated: { Replicas: 1 } }, EndpointSpec: { Mode: "vip" },
    UpdateConfig: { Parallelism: 1, Order: order, Monitor: 30e9, FailureAction: action.effect === "restore" ? "pause" : "rollback", MaxFailureRatio: 0 },
    RollbackConfig: { Parallelism: 1, Order: order, Monitor: 30e9, FailureAction: "pause", MaxFailureRatio: 0 },
  };
};

export const renderNativeManagedService = (input: ManagedServicePlan, requested: ManagedServiceAction, inputs: ManagedServiceInputs) => renderPrepared(prepare(input, requested, inputs));

/** Owned workload effects only. The coordinator supplies admission/fencing authority and persisted creation receipts. */
export const managedSwarmService = (api = dockerApi(), volumes: Pick<OwnedVolumePort, "observe"> = ownedVolumes(api), now: () => number = Date.now) => {
  const native = ownedSwarmService<ManagedServiceScope, ManagedServiceAction>({
    scope: (input) => { const parsed = scopeSchema.safeParse(input); return parsed.success ? parsed.data : undefined; }, action: parseAction, nativeName, ownership,
    taskOwned: (scope, labels) => Object.entries(ownership(scope)).every(([key, value]) => nativeField(labels, key) === value),
    matchesSpec: (actual, expected) => nativeSpecMatches(actual, expected, matchesMounts),
  }, api, now);
  const verifyVolumes = async (plan: ManagedServicePlan, inputs: ManagedServiceInputs, deadline: number) => {
    const recorded = matchManagedVolumeReceipts(plan, inputs.volumes); if (!recorded.ok) return false;
    const started = now(); const remaining = Math.min(10000, deadline - started);
    if (!Number.isSafeInteger(started) || !Number.isSafeInteger(remaining) || remaining <= 0) return false;
    // eslint-disable-next-line functional/no-let -- clear the single read-observation timer on completion
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const unique = recorded.value.filter((mount, index, all) => all.findIndex((item) => item.volume.allocation === mount.volume.allocation) === index);
      const observed = await Promise.race([
        Promise.all(unique.map((mount) => Promise.resolve().then(() => volumes.observe(mount.volume)).catch(() => undefined))),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, remaining); }),
      ]);
      const finished = now();
      return observed !== undefined && Number.isSafeInteger(finished) && finished >= started && finished - started < remaining && matchManagedVolumeEvidence(plan, inputs.volumes, observed).ok;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  return typed<ManagedSwarmServicePort>(Object.freeze({
    observe: (scope) => native.observe(scope),
    observeDesired: async (action, plan, inputs) => {
      try {
        const prepared = prepare(plan, action, inputs); const spec = renderPrepared(prepared);
        if (!(await verifyVolumes(prepared.plan, prepared.inputs, now() + 10000))) return { status: "unavailable" };
        return await native.observe(scopeOf(prepared.action), spec);
      } catch { return { status: "unavailable" }; }
    },
    apply: async (requested, expected, plan, inputs) => {
      const action = parseAction(requested);
      if (action === undefined || action.effect !== "apply" && action.effect !== "restore" || expected !== null && !validNativeVersion(expected)) return "refused";
      try {
        const left = action.deadline - now(); if (!Number.isSafeInteger(left) || left <= 0 || left > 90000) return "refused";
        const prepared = prepare(plan, action, inputs);
        if (prepared.plan.role === "retained-dependency" && expected !== null) return "refused";
        const spec = renderPrepared(prepared);
        if (!(await verifyVolumes(prepared.plan, prepared.inputs, action.deadline))) return "refused";
        return await native.replace(prepared.action, expected, spec);
      } catch { return "refused"; }
    },
    fence: native.fence, tombstone: native.tombstone,
  }));
};
