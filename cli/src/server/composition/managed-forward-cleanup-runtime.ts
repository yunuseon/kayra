import { parseManagedForwardCleanupContext, managedForwardCleanupServices } from "../../contracts/managed-forward-cleanup-context.ts";
import type { ManagedForwardCleanupContext, ManagedForwardCleanupRuntimePort } from "../../contracts/managed-forward-cleanup-context.ts";
import type { ManagedRuntimeAuthorityPort } from "../../contracts/managed-runtime-authority.ts";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { ManagedServiceAction, ManagedServiceScope, ManagedSwarmServicePort } from "../../contracts/managed-swarm-service.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import type { JobPort } from "../../contracts/one-shot-job.ts";
import { parseJobPlan } from "../../contracts/one-shot-job.ts";
import type { CheckContainerFencePort } from "../../contracts/check-container-fence.ts";
import { parseCheckContainerFence } from "../../contracts/check-container-fence.ts";
import { managedMigrationInputs } from "../deployment/managed-migration-inputs.ts";
import { typed } from "../../lib/typed.ts";

type Ports = { readonly now: () => number; readonly authority: ManagedRuntimeAuthorityPort;
  readonly native: { readonly services: Readonly<Pick<ManagedSwarmServicePort, "observe" | "tombstone">>; readonly jobs: Readonly<Pick<JobPort, "observe">>; readonly containers: CheckContainerFencePort } };

/** Trusted wiring on the existing native transport. Real blocked context supplies platform ownership; the reserved successor has only consumer stop/scrub capability. */
export const managedForwardCleanupRuntime = (input: ManagedForwardCleanupContext, ports: Ports) => {
  const checked = parseManagedForwardCleanupContext(input); if (!checked.ok) throw new Error("managed forward cleanup context unavailable"); const context = checked.value;
  const services = managedForwardCleanupServices(context); const owner = context.blocked.owner;
  const scope = (value: ManagedServiceScope) => value.app === owner.app && value.incarnation === owner.incarnation && value.dataOwner === owner.dataOwner && services.some((service) => service.service === value.service);
  const action = (input: ManagedServiceAction) => {
    const checked = parseManagedServiceAction(input); if (!checked.ok || !scope(checked.value)) return undefined; const value = checked.value; const service = services.find((service) => service.service === value.service);
    return service !== undefined && managedServiceDigest(service) === value.plan && ["remove", "scrub"].includes(value.effect) && value.deadline === context.deadline && new RegExp(`^${context.action}:quiesce:${value.effect}:[1-8]$`).test(value.action) ? service : undefined;
  };
  const timely = () => { const now = ports.now(); return Number.isSafeInteger(now) && now >= context.createdAt && now < context.deadline; };
  const bounded = async <T>(call: () => Promise<T>, deadline = ports.now() + 10_000) => {
    const left = Math.min(10_000, deadline - ports.now()); if (left <= 0) return undefined; const expired = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { expired.resolve(undefined); }, left);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), expired.promise]); } finally { clearTimeout(timer); }
  };
  // The platform owns this application's cleanup grant; the coordinator separately authenticates C's reservation and lease before effects.
  const owned = () => bounded(() => ports.authority.allowed(context.blocked, { kind: "recovery" })).then((allowed) => allowed === true);
  const allowed = async (value: ManagedServiceAction | null) => value === null ? owned() : action(value) !== undefined && timely() && await owned() && timely();
  return typed<ManagedForwardCleanupRuntimePort>(Object.freeze({ context, allowed,
    services: typed<Readonly<Pick<ManagedWorkloadPort, "observe" | "tombstone">>>({
      observe: async (value) => { if (!scope(value)) return { status: "foreign" }; return await owned() ? await bounded(() => ports.native.services.observe(value)) ?? { status: "unavailable" } : { status: "unavailable" }; },
      tombstone: async (value, expected, image) => {
        const service = action(value); if (service?.image !== image || !await allowed(value)) return "refused";
        return await bounded(() => ports.native.services.tombstone(value, expected, image), context.deadline) ?? "uncertain";
      },
    }),
    jobs: typed<Readonly<Pick<JobPort, "observe">>>({ observe: async (input) => {
      const value = parseJobPlan(input); if (!value.ok || value.value.scope.run !== context.blocked.run || value.value.deadline > context.blocked.deadline || value.value.deadline <= context.blocked.createdAt || !managedMigrationInputs(context.blocked.application, value.value).ok) return { status: "unavailable" };
      if (await bounded(() => ports.authority.allowed(context.blocked, { kind: "job", job: value.value, effect: "observe" })) !== true) return { status: "unavailable" };
      return await bounded(() => ports.native.jobs.observe(value.value)) ?? { status: "unavailable" };
    } }),
    containers: typed<CheckContainerFencePort>({ observe: async (input) => {
      const value = parseCheckContainerFence(input); if (!value.ok || action(value.value.barrier) === undefined || value.value.barrier.effect !== "scrub" || !context.checks.some((check) => JSON.stringify(check.target) === JSON.stringify(value.value.target) && value.value.native.id === check.native.id && value.value.native.version >= check.native.version)) return { status: "foreign" };
      return await owned() ? await bounded(() => ports.native.containers.observe(value.value)) ?? { status: "unavailable" } : { status: "unavailable" };
    } }),
  }));
};
