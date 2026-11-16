import { createHash } from "node:crypto";
import { z } from "zod";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { parseManagedApplicationPlan, managedMigrationSeconds } from "../../contracts/managed-application-plan.ts";
import { parseManagedServicePlan, managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import { serviceEffectAction } from "../../contracts/swarm-service.ts";
import { parseManagedRelease, managedReleaseDigest, managedReleaseBaselines } from "./managed-release.ts";
import { managedAdmissionDescription } from "./managed-transition.ts";
import { parseManagedServiceBarrier } from "./managed-service-barrier.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const native = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: positive }).strict().readonly();
const schema = z.object({ version: z.literal(1), run: z.uuid(), action: z.string().max(80), createdAt: positive,
  restore: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  candidate: z.unknown(), previous: z.unknown().nullable(),
  retained: z.array(z.object({ name: z.string(), kind: z.enum(["active", "barrier"]), action: z.unknown(), native }).strict().readonly()).max(32).readonly(),
  retired: z.array(z.object({ plan: z.unknown(), barrier: z.unknown() }).strict().readonly()).max(32).readonly(),
}).strict().readonly();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const checkWindow = (plan: ManagedApplicationPlan) => Math.max(90_000, plan.rollout.checks.reduce((total, step) => total + (90 + step.timeout_seconds) * 1000, 0));
const duration = (plan: ManagedApplicationPlan, previous: ManagedApplicationPlan | null) => 90_000 + (plan.rollout.strategy === "maintenance" ? 90_000 : 0) + 90_000 + Math.max(90_000, managedMigrationSeconds(plan) * 1000) + 90_000 + checkWindow(plan) + 90_000 + (previous === null ? 0 : checkWindow(previous)) + 90_000;
/** Private normalized run source, after immutable bundle validation and input comparison. It grants neither admission nor native effects. */
export const parseManagedLifecycleSource = (input: unknown) => {
  const raw = schema.parse(input); const candidate = parseManagedApplicationPlan(raw.candidate); if (!candidate.ok) throw new Error("invalid managed lifecycle candidate");
  const previous = raw.previous === null ? null : parseManagedRelease(raw.previous); const previousPlan = previous?.source.application ?? null;
  const admission = managedAdmissionDescription(candidate.value, previousPlan); if (!admission.ok) throw new Error(admission.error);
  const plan = admission.value.plan; const owner = plan.infrastructure.ownership;
  if (!new RegExp(`^${owner.incarnation}:[1-9][0-9]*$`).test(raw.action) || !Number.isSafeInteger(Number(raw.action.split(":")[1]))) throw new Error("invalid managed lifecycle action");
  const previousBaselines = previous === null ? Object.freeze([]) : managedReleaseBaselines(previous);
  if (raw.createdAt < (previous?.verification.verified?.at ?? 0) || previousBaselines.some((value) => Number(value.action.action.split(":")[1]) >= Number(raw.action.split(":")[1]))) throw new Error("managed lifecycle action does not fence the previous release");
  const retired = Object.freeze(raw.retired.map((value) => {
    const spec = parseManagedServicePlan(value.plan); const barrier = parseManagedServiceBarrier(value.barrier);
    if (!spec.ok || spec.value.role !== "retained-dependency" || !same(spec.value.owner, owner) || previousPlan?.services[spec.value.service] !== undefined ||
      spec.value.host.node !== plan.host.node || spec.value.host.cluster !== plan.host.cluster || !same(spec.value.privateNetwork, { id: plan.infrastructure.overlay.id, name: plan.infrastructure.overlay.scope.name }) ||
      barrier.phase !== "complete" || barrier.proof === null || barrier.steps.at(-1)?.effect !== "scrub" || barrier.action.app !== owner.app || barrier.action.incarnation !== owner.incarnation || barrier.action.dataOwner !== owner.dataOwner || barrier.action.service !== spec.value.service || barrier.action.plan !== managedServiceDigest(spec.value) ||
      Number(barrier.action.action.split(":")[1]) >= Number(raw.action.split(":")[1]) ||
      Object.values(plan.services).some((other) => other.role === "retained-dependency" && other.service !== spec.value.service && other.mounts.some((mount) => spec.value.mounts.some((old) => old.volume.allocation === mount.volume.allocation)))) throw new Error("managed lifecycle retired inventory disagrees");
    return Object.freeze({ plan: spec.value, barrier });
  }));
  const retained = Object.freeze(raw.retained.map((value) => {
    const action = parseManagedServiceAction(value.action); const spec = plan.services[value.name]; const old = previousBaselines.find((before) => before.name === value.name); const retirement = retired.find((before) => before.plan.service === value.name);
    const step = retirement?.barrier.steps.at(-1); const proof = retirement?.barrier.proof;
    if (!action.ok || spec?.role !== "retained-dependency" || action.value.app !== owner.app || action.value.incarnation !== owner.incarnation || action.value.dataOwner !== owner.dataOwner || action.value.service !== value.name || action.value.plan !== managedServiceDigest(spec) || Number(action.value.action.split(":")[1]) >= Number(raw.action.split(":")[1]) ||
      (value.kind === "active" ? old === undefined || action.value.effect !== "apply" && action.value.effect !== "restore" || retirement !== undefined || !same(old.action, action.value) || value.native.id !== old.native.id || value.native.version < old.native.version :
        retirement === undefined || proof === null || proof === undefined || step?.effect !== "scrub" || action.value.effect !== "scrub" || action.value.action !== serviceEffectAction(retirement.barrier.action.action, "scrub", step.attempt) || value.native.id !== proof.native.id || value.native.version < proof.native.version || managedServiceDigest(retirement.plan) !== action.value.plan)) throw new Error("managed lifecycle retained baseline disagrees");
    return Object.freeze({ ...value, action: action.value });
  }));
  if (new Set(retained.map((value) => value.name)).size !== retained.length || new Set(retired.map((value) => value.plan.service)).size !== retired.length ||
    Object.values(previousPlan?.services ?? {}).some((service) => service.role === "retained-dependency" && !retained.some((value) => value.name === service.service)) ||
    retired.some((value) => plan.services[value.plan.service] !== undefined && !retained.some((reference) => reference.name === value.plan.service && reference.kind === "barrier"))) throw new Error("managed lifecycle retained coverage disagrees");
  const deadline = raw.createdAt + duration(plan, previousPlan);
  if (!Number.isSafeInteger(deadline)) throw new Error("managed lifecycle deadline exceeds clock range");
  return Object.freeze({ version: 1 as const, run: raw.run, action: raw.action, createdAt: raw.createdAt, restore: raw.restore, candidate: plan, previous, retained, retired });
};
export type ManagedLifecycleSource = ReturnType<typeof parseManagedLifecycleSource>;
export const managedLifecycleSourceDigest = (input: ManagedLifecycleSource) => createHash("sha256").update(JSON.stringify(parseManagedLifecycleSource(input))).digest("hex");
export const managedLifecycleDescription = (input: ManagedLifecycleSource) => {
  const source = parseManagedLifecycleSource(input); const previous = source.previous?.source.application ?? null; const checked = managedAdmissionDescription(source.candidate, previous); if (!checked.ok) throw new Error(checked.error);
  const deadline = source.createdAt + duration(source.candidate, previous);
  return Object.freeze({ source, admission: checked.value, previous: source.previous === null ? null : managedReleaseDigest(source.previous), admissionDeadline: source.createdAt + 90_000, deadline,
    baselines: Object.freeze((source.previous === null ? [] : managedReleaseBaselines(source.previous)).filter((value) => previous?.services[value.name]?.role !== "retained-dependency")),
  });
};
