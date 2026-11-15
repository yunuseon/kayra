import { parseManagedApplicationPlan, managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { parseManagedServicePlan, managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import type { ManagedServicePlan } from "../../contracts/managed-service-plan.ts";
import type { RetainedInputsPort } from "../../contracts/service-inputs.ts";
import type { ResourceBudget, SwarmHostObservation } from "../../contracts/resource-authority.ts";
import { all, err, ok } from "../../lib/result.ts";
import { retainService } from "./retained-service.ts";
import { reserveResources } from "./resource-book.ts";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const routesFor = (plan: ManagedApplicationPlan, service: string) => JSON.stringify(plan.routes.filter((route) => route.service === service));
const empty = Object.freeze({ cpu: 0, memory: 0 });
const amount = (service: ManagedServicePlan) => Object.freeze({ cpu: Math.ceil(service.resources.nanoCpus / 1_000_000), memory: service.resources.memoryBytes });
const sum = (values: readonly ResourceBudget[]) => Object.freeze(values.reduce<ResourceBudget>((total, value) => Object.freeze({ cpu: total.cpu + value.cpu, memory: total.memory + value.memory }), empty));
const maximum = (values: readonly ResourceBudget[]) => Object.freeze(values.reduce<ResourceBudget>((total, value) => Object.freeze({ cpu: Math.max(total.cpu, value.cpu), memory: Math.max(total.memory, value.memory) }), empty));
const validBudget = (value: ResourceBudget) => Number.isSafeInteger(value.cpu) && value.cpu >= 0 && Number.isSafeInteger(value.memory) && value.memory >= 0;
const budget = (previous: ManagedApplicationPlan | null, candidate: ManagedApplicationPlan) => {
  const consumers = (plan: ManagedApplicationPlan | null) => plan === null ? empty : sum(Object.values(plan.services).filter((service) => service.role !== "retained-dependency").map(amount));
  const retained = sum(Object.values(candidate.services).filter((service) => service.role === "retained-dependency").map(amount));
  const old = consumers(previous); const target = consumers(candidate);
  const job = maximum(candidate.rollout.migrations.map((step) => { const service = candidate.services[step.service]; return service === undefined ? empty : amount(service); }));
  // A fenced or uncertain migration may overlap its admitted probe. Rollback can overlap old, candidate and restored consumers.
  const startup = sum([retained, old]); const migration = sum([retained, old, job, job]); const recovery = sum([retained, target, old, old]);
  const targetBudget = sum([retained, target]); const previousBudget = previous === null ? null : sum(Object.values(previous.services).map(amount));
  const peak = maximum([startup, migration, recovery, targetBudget, previousBudget ?? empty]);
  return Object.freeze({ target: targetBudget, previous: previousBudget, peak, frames: Object.freeze({ startup, migration, recovery }) });
};

/** No effects. Baselines include retained dependencies created by an earlier failed operation, even without a verified active release. */
export const prepareManagedTransition = async (previous: ManagedApplicationPlan | null, candidate: ManagedApplicationPlan, baselines: readonly ManagedServicePlan[], inputs: RetainedInputsPort, clock: { readonly deadline: number; readonly now: () => number }) => {
  const now = clock.now(); const remaining = clock.deadline - now;
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(clock.deadline) || !Number.isFinite(remaining) || remaining <= 0 || remaining > 90_000) return err("managed transition preparation deadline is invalid or expired");
  const next = parseManagedApplicationPlan(candidate); const before = previous === null ? null : parseManagedApplicationPlan(previous);
  if (!next.ok || before !== null && !before.ok) return err("invalid managed transition plans");
  const old = before === null ? null : before.value; const target = next.value;
  if (old !== null && (!same(old.infrastructure.ownership, target.infrastructure.ownership) || !same(old.host, target.host) || !same(old.infrastructure.overlay, target.infrastructure.overlay))) return err("ordinary managed transitions cannot change ownership, host or private infrastructure");
  if (old !== null && Object.values(target.services).some((service) => service.role === "retained-dependency" && old.services[service.service] !== undefined && old.services[service.service]?.role !== "retained-dependency")) return err("ordinary deployments cannot repurpose an existing consumer as a retained dependency");
  if (old !== null && target.rollout.strategy === "rolling" && target.routes.some((route) => {
    const previous = old.routes.find((before) => before.host === route.host && before.path === route.path);
    return previous !== undefined && previous.service !== route.service;
  })) return err("rolling transitions cannot move an existing route between services; declare granted maintenance instead");
  if (baselines.length > 32) return err("too many retained dependency baselines");
  const recorded = all(baselines.map(parseManagedServicePlan)); if (!recorded.ok) return err("invalid retained dependency baselines");
  const retained = [...(old === null ? [] : Object.values(old.services).filter((service) => service.role === "retained-dependency")), ...recorded.value];
  if (retained.some((service) => service.role !== "retained-dependency" || !same(service.owner, target.infrastructure.ownership) ||
    retained.some((other) => service.service === other.service && managedServiceDigest(service) !== managedServiceDigest(other)))) return err("retained dependency baselines disagree");
  const unique = retained.filter((service, index) => retained.findIndex((other) => service.service === other.service) === index);
  if (unique.some((service) => target.services[service.service] === undefined)) return err("ordinary deployments cannot remove retained dependencies");
  const comparisons = Promise.all(unique.map(async (service) => {
    if (clock.now() >= clock.deadline) return err("managed transition preparation deadline expired");
    const spec = target.services[service.service]; if (spec === undefined) return err("retained dependency declaration is missing");
    const reused = await retainService(service, spec, inputs); return reused.ok ? ok(Object.freeze({ name: service.service, plan: reused.value })) : reused;
  }));
  const timeout = Promise.withResolvers<null>();
  const timer = setTimeout(() => { timeout.resolve(null); }, Math.max(0, clock.deadline - clock.now()));
  const completed = await Promise.race([comparisons, timeout.promise]).finally(() => { clearTimeout(timer); });
  if (completed === null || clock.now() >= clock.deadline) return err("managed transition preparation deadline expired");
  const carried = all(completed);
  if (!carried.ok) return carried;
  const services = Object.freeze({ ...target.services, ...Object.fromEntries(carried.value.map((item) => [item.name, item.plan] as const)) });
  const normalized = parseManagedApplicationPlan({ ...target, services }); if (!normalized.ok) return normalized;
  const plan = normalized.value; const resources = budget(old, plan);
  if (![resources.target, resources.previous ?? empty, resources.peak].every(validBudget) || resources.peak.cpu > plan.grants.cpu_millicores || resources.peak.memory > plan.grants.memory_bytes) return err("managed transition overlap, jobs and recovery exceed application grants");
  const rollbackEligible = old !== null && plan.rollout.rollback_compatible && old.routes.every((route) => plan.hosts.includes(route.host)) && Object.values(old.services).every((service) => Object.values(service.inputs.environment).every((binding) => binding.kind !== "secret" || plan.secrets.includes(binding.key)));
  if (plan.rollout.strategy === "rolling" && old !== null && !rollbackEligible) return err("rolling transition cannot restore its previous route or secret grants");
  const changes = Object.entries(plan.services).map(([name, service]) => Object.freeze({ name, kind: service.role === "retained-dependency" && unique.some((baseline) => baseline.service === name) ? "retained" : old?.services[name] === undefined ? "create" : managedServiceDigest(old.services[name]) === managedServiceDigest(service) && routesFor(old, name) === routesFor(plan, name) ? "unchanged" : "replace" }));
  const removed = old === null ? [] : Object.keys(old.services).filter((name) => !Object.hasOwn(plan.services, name));
  return ok(Object.freeze({ plan, previous: old, resources, rollbackEligible, changes: Object.freeze(changes), removed: Object.freeze(removed), planDigest: managedApplicationDigest(plan) }));
};
export type ManagedTransition = Extract<Awaited<ReturnType<typeof prepareManagedTransition>>, { readonly ok: true }>["value"];

/** Caller holds the exclusive accounting owner and synchronizes the returned book before any effect. A replay is only a read, never renewed authority. */
export const reserveManagedTransition = (book: unknown, observation: SwarmHostObservation, transition: ManagedTransition, sequence: number, deadline: number, now: number) => {
  const candidate = parseManagedApplicationPlan(transition.plan); const previous = transition.previous === null ? null : parseManagedApplicationPlan(transition.previous);
  if (!candidate.ok || previous !== null && !previous.ok || managedApplicationDigest(candidate.value) !== transition.planDigest) return err("managed transition admission integrity failed");
  const plan = candidate.value; const old = previous === null ? null : previous.value; const resources = budget(old, plan);
  if (!same(resources, transition.resources) || resources.peak.cpu > plan.grants.cpu_millicores || resources.peak.memory > plan.grants.memory_bytes) return err("managed transition resource envelope changed");
  return reserveResources(book, plan.host, observation, { app: plan.infrastructure.registration.app, incarnation: plan.infrastructure.registration.incarnation, sequence,
    previous: old === null || resources.previous === null ? null : { plan: managedApplicationDigest(old), budget: resources.previous },
    target: { plan: transition.planDigest, budget: resources.target }, peak: resources.peak, deadline, result: "pending",
  }, now);
};
