import { parseManagedServicePlan, managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import type { ManagedServicePlan } from "../../contracts/managed-service-plan.ts";
import { parseManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import type { RetainedInputsPort } from "../../contracts/service-inputs.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import { serviceEffectAction } from "../../contracts/swarm-service.ts";
import { parseManagedServiceBarrier } from "./managed-service-barrier.ts";
import type { ManagedServiceBarrier } from "./managed-service-barrier.ts";
import { prepareManagedTransition } from "./managed-transition.ts";
import { clearedService } from "./service-convergence.ts";
import { all, err, ok } from "../../lib/result.ts";
import type { RetainedBaseline } from "./managed-group-preparation.ts";

export type RetiredDependency = { readonly plan: ManagedServicePlan; readonly barrier: ManagedServiceBarrier };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
/** An omitted retained dependency stays in the private data inventory. This does not delete its volume, image pins or immutable specification. */
export const prepareManagedInventoryTransition = async (input: {
  readonly previous: ManagedApplicationPlan | null; readonly candidate: ManagedApplicationPlan;
  readonly active: readonly ManagedServicePlan[]; readonly retired: readonly RetiredDependency[];
}, ports: { readonly inputs: RetainedInputsPort; readonly services: Pick<ManagedWorkloadPort, "observe">; readonly now: () => number }, deadline: number) => {
  const now = ports.now(); if (!Number.isSafeInteger(now) || now < 1 || !Number.isSafeInteger(deadline) || deadline <= now || deadline - now > 90_000) return err("retained inventory preparation deadline is invalid or expired");
  if (input.active.length > 32 || input.retired.length > 32) return err("retained inventory exceeds scheduling limits");
  const active = all(input.active.map(parseManagedServicePlan)); const previous = input.previous === null ? null : parseManagedApplicationPlan(input.previous);
  if (!active.ok || previous !== null && !previous.ok) return err("invalid active retained inventory");
  const candidate = parseManagedApplicationPlan(input.candidate); if (!candidate.ok) return err("invalid retained inventory candidate");
  const plan = candidate.value; const owner = plan.infrastructure.ownership;
  const retired = (() => { try { return Object.freeze(input.retired.map((value) => { const spec = parseManagedServicePlan(value.plan); const barrier = parseManagedServiceBarrier(value.barrier); return spec.ok ? Object.freeze({ plan: spec.value, barrier }) : null; })); } catch { return null; } })();
  if (retired === null || retired.length > 32 || retired.some((value) => value === null)) return err("invalid retired dependency inventory");
  const records = Object.freeze(retired.flatMap((value) => Object.freeze(value === null ? [] : [value])));
  if (new Set(records.map((value) => value.plan.service)).size !== records.length || records.some(({ plan: spec, barrier }) => {
    const action = barrier.action; const step = barrier.steps.at(-1);
    return spec.role !== "retained-dependency" || !same(spec.owner, owner) || spec.host.node !== plan.host.node || spec.host.cluster !== plan.host.cluster || !same(spec.privateNetwork, { id: plan.infrastructure.overlay.id, name: plan.infrastructure.overlay.scope.name }) ||
      active.value.some((active) => active.service === spec.service) || (previous?.value.services[spec.service]) !== undefined ||
      barrier.phase !== "complete" || barrier.proof === null || step?.effect !== "scrub" || action.app !== owner.app || action.incarnation !== owner.incarnation || action.dataOwner !== owner.dataOwner || action.service !== spec.service || action.plan !== managedServiceDigest(spec) ||
      plan.services[spec.service] !== undefined && plan.services[spec.service]?.role !== "retained-dependency" ||
      Object.values(plan.services).some((other) => other.role === "retained-dependency" && other.service !== spec.service && other.mounts.some((mount) => spec.mounts.some((old) => old.volume.allocation === mount.volume.allocation)));
  })) return err("retired dependency ownership, retirement proof or active set disagrees");
  // eslint-disable-next-line functional/prefer-immutable-types -- local collection is published only as a frozen checked set
  const reactivation: RetainedBaseline[] = [];
  for (const record of records) {
    const { barrier, plan: spec } = record; const step = barrier.steps.at(-1); const proof = barrier.proof; if (step === undefined || proof === null) return err("retired dependency barrier is missing");
    const current = ports.now(); const remaining = deadline - current; if (!Number.isSafeInteger(current) || current < now || remaining <= 0 || remaining > 90_000) return err("retained inventory preparation deadline expired");
    const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, remaining);
    const observed = await Promise.race([Promise.resolve().then(() => ports.services.observe({ app: owner.app, incarnation: owner.incarnation, dataOwner: owner.dataOwner, service: spec.service })).catch(() => undefined), timeout.promise]).finally(() => { clearTimeout(timer); });
    const action = Object.freeze({ ...barrier.action, action: serviceEffectAction(barrier.action.action, "scrub", step.attempt), effect: "scrub" as const });
    const after = ports.now(); if (!Number.isSafeInteger(after) || after < current || after >= deadline) return err("retained inventory preparation deadline expired");
    if (observed?.status !== "owned" || !clearedService(observed) || observed.id !== proof.native.id || observed.version < proof.native.version || observed.action !== action.action || observed.plan !== action.plan || observed.effect !== "scrub") return err("retired dependency no longer has its owned container-free barrier");
    if (plan.services[spec.service] !== undefined) {
      // eslint-disable-next-line functional/immutable-data -- publishes only a complete freshly observed baseline set
      reactivation.push(Object.freeze({ name: spec.service, kind: "barrier", action, native: Object.freeze({ id: observed.id, version: observed.version }) }));
    }
  }
  const included = records.filter((value) => plan.services[value.plan.service] !== undefined).map((value) => value.plan);
  const transition = await prepareManagedTransition(previous?.value ?? null, plan, [...active.value, ...included], ports.inputs, { deadline, now: ports.now });
  return transition.ok ? ok(Object.freeze({ transition: transition.value, retired: records, reactivation: Object.freeze(reactivation) })) : transition;
};
