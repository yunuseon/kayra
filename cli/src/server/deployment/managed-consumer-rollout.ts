import type { ManagedChecksPort } from "../../contracts/container-check.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { managedApplicationDigest, parseManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import type { ManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import type { ManagedRoutedReadinessPort } from "../../contracts/routed-readiness.ts";
import type { ServiceObservation, ServiceVersion } from "../../contracts/swarm-service.ts";
import { parseManagedGroupPreparation } from "./managed-group-preparation.ts";
import type { ManagedGroupPreparation } from "./managed-group-preparation.ts";
import { parseManagedConsumerState } from "./managed-consumer-state.ts";
import type { ManagedConsumerState } from "./managed-consumer-state.ts";
import { managedServiceExecution, parseManagedServiceExecution } from "./managed-service-execution.ts";
import { managedServiceBarrier, parseManagedServiceBarrier } from "./managed-service-barrier.ts";
import { clearedService, convergedService } from "./service-convergence.ts";
import { routedHttp } from "./http-convergence.ts";
import { claimJournal } from "./journal-claim.ts";
import type { OperationJournal } from "./operation.ts";

export type ConsumerBaseline = { readonly name: string; readonly action: ManagedServiceAction; readonly native: ServiceVersion };
type Ports = { readonly checks?: ManagedChecksPort | undefined; readonly now: () => number; readonly read: (digest: string) => Promise<string>; readonly retain: (bytes: string) => Promise<string>;
  readonly services: ManagedWorkloadPort; readonly readiness: ManagedRoutedReadinessPort;
  readonly authorize: (state: ManagedConsumerState, effect: { readonly kind: "service"; readonly action: ManagedServiceAction } | { readonly kind: "verify" }) => Promise<boolean>;
};
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scope = (state: ManagedConsumerState, service: string) => Object.freeze({ app: state.app, incarnation: state.incarnation, dataOwner: state.dataOwner, service });
const healthy = (observed: ServiceObservation, actions: readonly ManagedServiceAction[]) => observed.status === "owned" && observed.specMatches === true && !observed.tombstone && observed.replicas === 1 && observed.endpoint === "vip" &&
  observed.tasks.some((task) => task.desired === "running" && task.state === "running" && task.health === "healthy" && actions.some((action) => task.incarnation === action.incarnation && task.action === action.action && task.plan === action.plan && task.effect === action.effect));

/** Forward consumer reconciliation only; held work requires the group recovery owner, and ready is never release promotion. */
export const managedConsumerRollout = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "managed consumer rollout already has an owner");
  // eslint-disable-next-line functional/no-let -- one writer owns all child views
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- synchronization uncertainty poisons the live handle
  let poisoned = false;
  const serial = <T>(call: () => Promise<T>) => { const result = pending.then(() => { if (poisoned) throw new Error("managed consumer write is uncertain; reopen and reconcile"); return call(); }); pending = result.then(() => undefined, () => undefined); return result; };
  const executions = new Map<string, ReturnType<typeof managedServiceExecution>>(); const barriers = new Map<string, ReturnType<typeof managedServiceBarrier>>();
  const time = (minimum = 1) => { const now = ports.now(); if (!Number.isSafeInteger(now) || now < minimum) throw new Error("managed consumer clock is unavailable"); return now; };
  const load = async () => { const value = await journal.read(); return value === undefined ? undefined : parseManagedConsumerState(value); };
  const required = async () => { const state = await load(); if (state === undefined) throw new Error("managed consumer intent is missing"); return state; };
  const write = async (value: ManagedConsumerState) => { const state = parseManagedConsumerState(value); try { await journal.write(state); } catch { poisoned = true; throw new Error("managed consumer write is uncertain; reopen and reconcile"); } return state; };
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => {
    const remaining = deadline - time(); if (remaining <= 0) return undefined;
    const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, remaining);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); } finally { clearTimeout(timer); }
  };
  const validatePlans = (state: ManagedConsumerState, target: ManagedApplicationPlan, previous: ManagedApplicationPlan | null) => {
    if (state.nodes.some((node) => state.phase === "ready" && target.services[node.name]?.role === "http" && (node.ready?.kind !== "running" || node.ready.routed === null))) throw new Error("managed HTTP readiness proof is missing");
    return validateScope(state, target, previous);
  };
  const validateScope = (state: ManagedConsumerState, target: ManagedApplicationPlan, previous: ManagedApplicationPlan | null) => {
    if (target.infrastructure.ownership.app !== state.app || target.infrastructure.ownership.incarnation !== state.incarnation || target.infrastructure.ownership.dataOwner !== state.dataOwner ||
      previous !== null && (!same(previous.infrastructure.ownership, target.infrastructure.ownership) || !same(previous.host, target.host) || !same(previous.infrastructure.overlay, target.infrastructure.overlay)) ||
      state.nodes.some((node) => { const service = target.services[node.name]; const before = previous?.services[node.name]; return (service === undefined || service.role === "retained-dependency" ? node.target !== null : node.target !== managedServiceDigest(service)) ||
        (before === undefined || before.role === "retained-dependency" ? node.baseline !== null : node.baseline?.action.plan !== managedServiceDigest(before)); }) ||
      [...Object.values(target.services), ...Object.values(previous?.services ?? {})].some((service) => service.role !== "retained-dependency" && !state.nodes.some((node) => node.name === service.service)) ||
      state.retained.length !== Object.values(target.services).filter((service) => service.role === "retained-dependency").length || state.retained.some((value) => { const service = target.services[value.name]; return service?.role !== "retained-dependency" || value.action.plan !== managedServiceDigest(service); })) throw new Error("managed consumer scope or service set disagrees");
    return Object.freeze({ target, previous });
  };
  const plans = async (state: ManagedConsumerState) => {
    const read = async (digest: string) => { const bytes = await bounded(time() + 10_000, () => ports.read(digest)); if (bytes === undefined) throw new Error("managed consumer plan is unavailable"); const raw: unknown = JSON.parse(bytes); const parsed = parseManagedApplicationPlan(raw); if (!parsed.ok || bytes !== JSON.stringify(parsed.value) || managedApplicationDigest(parsed.value) !== digest) throw new Error("managed consumer plan integrity failed"); return parsed.value; };
    const target = await read(state.plan); const previous = state.previous === null ? null : await read(state.previous);
    return validatePlans(state, target, previous);
  };
  const desired = async (action: ManagedServiceAction, service: string, plan: ManagedApplicationPlan, deadline: number) => { const spec = plan.services[service]; return spec === undefined ? Object.freeze({ status: "unavailable" as const }) : await bounded(Math.min(deadline, time() + 10_000), () => ports.services.observeDesired(action, spec, plan)) ?? Object.freeze({ status: "unavailable" as const }); };
  const retainedHealthy = async (state: ManagedConsumerState, plan: ManagedApplicationPlan) => {
    const checks = await bounded(Math.min(state.deadline, time() + 10_000), async () => Object.freeze(await Promise.all(state.retained.map(async (value) => {
      const observed = await desired(value.action, value.name, plan, state.deadline);
      return observed.status === "owned" && observed.id === value.native.id && observed.version >= value.native.version && convergedService(value.action, observed);
    }))));
    return checks?.every(Boolean) === true;
  };
  const dependenciesHealthy = async (state: ManagedConsumerState, name: string, target: ManagedApplicationPlan, previous: ManagedApplicationPlan | null) => {
    const spec = target.services[name]; if (spec === undefined) return false;
    for (const dependency of spec.dependencies) {
      const retained = state.retained.find((value) => value.name === dependency.service);
      if (retained !== undefined) {
        const observed = await desired(retained.action, retained.name, target, state.deadline);
        if (observed.status !== "owned" || observed.id !== retained.native.id || observed.version < retained.native.version || !convergedService(retained.action, observed)) return false; continue;
      }
      const node = state.nodes.find((value) => value.name === dependency.service); if (node === undefined) return false;
      const actions = [...(node.execution === null ? [] : [node.execution.action]), ...(node.baseline === null ? [] : [node.baseline.action])];
      if (node.execution !== null && healthy(await desired(node.execution.action, node.name, target, state.deadline), actions)) continue;
      if (previous !== null && node.baseline !== null && node.quiescence === null && healthy(await desired(node.baseline.action, node.name, previous, state.deadline), actions)) continue;
      return false;
    }
    return true;
  };
  const execution = (name: string, context: ManagedApplicationPlan) => {
    const old = executions.get(name); if (old !== undefined) return old;
    const owner = managedServiceExecution({ read: async () => (await required()).nodes.find((node) => node.name === name)?.execution ?? undefined, write: async (value: unknown) => {
      const state = await required(); if (state.phase !== "updating") throw new Error("managed consumer slot lost ownership"); const child = parseManagedServiceExecution(value); await write({ ...state, nodes: state.nodes.map((node) => node.name === name ? { ...node, execution: child } : node) });
    } }, { ...ports, runtime: { apply: (action, expected, spec) => ports.services.apply(action, expected, spec, context), observeDesired: (action, spec) => ports.services.observeDesired(action, spec, context) }, authorize: async (child) => {
      const state = await required(); const source = await plans(state);
      return state.phase === "updating" && same(state.nodes.find((node) => node.name === name)?.execution, child) && await retainedHealthy(state, source.target) && await dependenciesHealthy(state, name, source.target, source.previous) && ports.authorize(state, { kind: "service", action: child.action });
    } });
    // eslint-disable-next-line functional/immutable-data -- a single child owns each service slot
    executions.set(name, owner); return owner;
  };
  const barrier = (name: string) => {
    const old = barriers.get(name); if (old !== undefined) return old;
    const owner = managedServiceBarrier({ read: async () => (await required()).nodes.find((node) => node.name === name)?.quiescence ?? undefined, write: async (value: unknown) => {
      const state = await required(); if (state.phase !== "updating") throw new Error("managed consumer barrier lost ownership"); const child = parseManagedServiceBarrier(value); await write({ ...state, nodes: state.nodes.map((node) => node.name === name ? { ...node, quiescence: child } : node) });
    } }, { ...ports, runtime: ports.services, authorize: async (_child, action) => { const state = await required(); return state.phase === "updating" && ports.authorize(state, { kind: "service", action }); } });
    // eslint-disable-next-line functional/immutable-data -- a single child owns each quiescence slot
    barriers.set(name, owner); return owner;
  };
  const hold = (state: ManagedConsumerState, reason: "deadline" | "service" | "dependency" | "authorization") => write({ ...state, phase: "held", reason, verifiedAt: null });
  return Object.freeze({
    prepare: (input: ManagedApplicationPlan, prefix: ManagedGroupPreparation, previous: ManagedApplicationPlan | null, references: readonly ConsumerBaseline[]) => {
      const checked = parseManagedApplicationPlan(input); const before = previous === null ? null : parseManagedApplicationPlan(previous); const preparation = parseManagedGroupPreparation(prefix);
      if (!checked.ok || before !== null && !before.ok || preparation.phase !== "ready" || preparation.consumerDeadline === null || preparation.plan !== managedApplicationDigest(checked.value)) return Promise.reject(new Error("managed consumer handoff disagrees"));
      const target = checked.value; const old = before === null ? null : before.value; const consumerDeadline = preparation.consumerDeadline;
      const prior = z.array(z.object({ name: z.string(), action: z.unknown(), native: z.object({ id: z.string(), version: z.number() }).strict() }).strict()).max(32).safeParse(references); if (!prior.success) return Promise.reject(new Error("invalid consumer baseline references"));
      const baselines = Object.freeze(prior.data.map((value) => { const action = parseManagedServiceAction(value.action); if (!action.ok) throw new Error("invalid consumer baseline action"); return Object.freeze({ ...value, native: Object.freeze(value.native), action: action.value }); }));
      return serial(async () => {
        if (target.rollout.strategy !== "rolling" || ports.checks === undefined && (target.rollout.checks.length !== 0 || Object.values(target.services).some((service) => service.overlap === "coordinated"))) throw new Error("managed consumer capabilities are unavailable for maintenance or checks");
        if (old !== null && (!same(old.infrastructure.ownership, target.infrastructure.ownership) || !same(old.host, target.host) || !same(old.infrastructure.overlay, target.infrastructure.overlay) ||
          old.routes.some((route) => !target.hosts.includes(route.host)) || Object.values(old.services).some((service) => Object.values(service.inputs.environment).some((binding) => binding.kind === "secret" && !target.secrets.includes(binding.key))) ||
          Object.values(old.services).some((service) => { const next = target.services[service.service]; return service.role === "retained-dependency" && (next === undefined || managedServiceDigest(service) !== managedServiceDigest(next)); }))) throw new Error("managed consumer previous scope or recovery grants disagree");
        if (old !== null && target.routes.some((route) => old.routes.some((before) => before.host === route.host && before.path === route.path && before.service !== route.service))) throw new Error("rolling consumer routes cannot move between services");
        if (Object.values(target.services).some((service) => service.role === "retained-dependency" && old?.services[service.service] !== undefined && old.services[service.service]?.role !== "retained-dependency")) throw new Error("consumer cannot become a retained dependency");
        const names = [...new Set([...Object.values(target.services), ...Object.values(old?.services ?? {})].filter((service) => service.role !== "retained-dependency").map((service) => service.service))].toSorted();
        if (names.length > 32) throw new Error("managed consumer transition exceeds scheduling limit");
        const nodes = names.map((name) => {
          const service = target.services[name]; const baseline = baselines.find((value) => value.name === name); const previous = old?.services[name];
          if (baseline !== undefined && (previous === undefined || baseline.action.plan !== managedServiceDigest(previous))) throw new Error("managed consumer baseline digest disagrees");
          if ((previous !== undefined && previous.role !== "retained-dependency") !== (baseline !== undefined)) throw new Error("managed consumer baseline set is incomplete");
          return Object.freeze({ name, target: service === undefined || service.role === "retained-dependency" ? null : managedServiceDigest(service), baseline: baseline === undefined ? null : Object.freeze({ action: baseline.action, native: baseline.native }), execution: null, quiescence: null, ready: null });
        });
        if (new Set(baselines.map((value) => value.name)).size !== baselines.length || baselines.some((value) => !names.includes(value.name))) throw new Error("managed consumer baseline set disagrees");
        const request = parseManagedConsumerState({ version: 1, app: preparation.app, incarnation: preparation.incarnation, dataOwner: preparation.dataOwner, run: preparation.run, action: preparation.action,
          plan: preparation.plan, previous: old === null ? null : managedApplicationDigest(old), preparation: hash(preparation), createdAt: consumerDeadline - 90_000, deadline: consumerDeadline,
          retained: preparation.nodes.map((node) => { if (node.ready === null) throw new Error("managed retained preparation is incomplete"); return Object.freeze({ name: node.name, action: node.ready.action, native: node.ready.native }); }),
          nodes, cursor: 0, phase: "updating", reason: null, verifiedAt: null });
        const existing = await load(); if (existing !== undefined) { if (existing.plan !== request.plan || existing.previous !== request.previous || existing.preparation !== request.preparation || !same(existing.nodes.map((node) => node.baseline), nodes.map((node) => node.baseline))) throw new Error("managed consumer intent conflicts"); await plans(existing); return existing; }
        if (time(request.createdAt) >= request.deadline) throw new Error("managed consumer window expired");
        for (const plan of [target, ...(old === null ? [] : [old])]) if (await bounded(request.deadline, () => ports.retain(JSON.stringify(plan))) !== managedApplicationDigest(plan)) throw new Error("managed consumer plan retention failed");
        validatePlans(request, target, old); return write(request);
      });
    },
    read: () => serial(load),
    tick: () => serial(async () => {
      const state = await required(); if (state.phase === "held" || state.phase === "ready") return state;
      const now = time(state.createdAt); if (now >= state.deadline) return hold(state, "deadline"); const source = await plans(state);
      if (!await retainedHealthy(state, source.target)) return state;
      if (state.nodes.every((node) => node.ready !== null)) {
        // eslint-disable-next-line functional/prefer-immutable-types -- local evidence collection is published only after every check succeeds
        const refreshed: ManagedConsumerState["nodes"][number][] = [];
        for (const node of state.nodes) {
          if (node.target === null) { const observed = await bounded(Math.min(state.deadline, time() + 10_000), () => ports.services.observe(scope(state, node.name))); if (observed === undefined || !clearedService(observed) || observed.status !== "owned" || observed.id !== node.ready?.native.id || observed.version < node.ready.native.version || ![null, "completed", "rollback_completed"].includes(observed.update)) return hold(state, "service"); // eslint-disable-next-line functional/immutable-data -- collects freshly checked evidence before one journal write
          refreshed.push(node); continue; }
          const spec = source.target.services[node.name]; const action = node.execution?.action; if (spec === undefined || action === undefined) throw new Error("managed candidate proof is missing");
          const observed = await bounded(Math.min(state.deadline, time() + 10_000), () => desired(action, node.name, source.target, state.deadline)); if (observed === undefined || !convergedService(action, observed) || observed.status !== "owned") return hold(state, "service");
          const routed = spec.role === "http" ? await bounded(state.deadline, () => ports.readiness.check(action, source.target)) : null;
          const at = time(state.createdAt); if (at >= state.deadline) return hold(state, "deadline"); if (spec.role === "http" && (routed === undefined || routed === null || !routedHttp(action, routed, at))) return state;
          // eslint-disable-next-line functional/immutable-data -- collects freshly checked evidence before one journal write
          refreshed.push(Object.freeze({ ...node, ready: { kind: "running" as const, action, native: { id: observed.id, version: observed.version }, at, routed: routed ?? null } }));
        }
        if (await bounded(state.deadline, () => ports.authorize(state, { kind: "verify" })) !== true) return hold(state, "authorization");
        const at = time(state.createdAt); if (at >= state.deadline) return hold(state, "deadline");
        if (refreshed.some((node) => node.ready?.kind === "running" && node.ready.routed !== null && !routedHttp(node.ready.action, node.ready.routed, at))) return state;
        return write({ ...state, nodes: refreshed, phase: "ready", verifiedAt: at });
      }
      // Round-robin dispatch lets independent services overlap their native monitoring windows under one writer.
      const pending = state.nodes.map((node, index) => Object.freeze({ node, index })).filter(({ node }) => node.ready === null);
      const selected = pending.find(({ index }) => index >= state.cursor) ?? pending[0]; if (selected === undefined) throw new Error("managed consumer scheduler is inconsistent");
      const cursor = (selected.index + 1) % Math.max(1, state.nodes.length); const current = await write({ ...state, cursor }); const node = selected.node;
      const target = source.target.services[node.name]; const previous = source.previous?.services[node.name];
      const quiesce = previous !== undefined && (target === undefined || previous.overlap === "forbidden" && target.overlap !== "forbidden");
      if (quiesce) {
        if (node.quiescence === null) { if (node.baseline === null) throw new Error("managed quiescence baseline is missing"); await barrier(node.name).prepare(previous, { ...scope(current, node.name), action: current.action, plan: managedServiceDigest(previous), deadline: current.deadline, effect: "remove" }, [node.baseline.native]); return required(); }
        if (node.quiescence.phase === "held") return hold(current, "service");
        if (node.quiescence.phase !== "complete") { await barrier(node.name).tick(); return required(); }
        if (target === undefined) {
          const proof = node.quiescence.proof; if (proof === null) throw new Error("managed removal proof is missing");
          return write({ ...current, nodes: current.nodes.map((value) => value.name === node.name ? { ...value, ready: { kind: "removed", native: proof.native, at: time(current.createdAt) } } : value) });
        }
      }
      if (target === undefined || target.role === "retained-dependency") throw new Error("managed consumer target is missing");
      if (node.execution !== null) {
        if (node.execution.phase === "held") return hold(current, "service");
        if (node.execution.phase === "planned" && !await dependenciesHealthy(current, node.name, source.target, source.previous)) return current;
        const child = await execution(node.name, source.target).tick(); const verified = child.verified;
        if (child.phase === "held") return hold(await required(), "service");
        if (child.phase === "converged" && verified !== null) { const after = await required(); return write({ ...after, nodes: after.nodes.map((value) => value.name === node.name ? { ...value, ready: { kind: "running", action: child.action, native: verified.native, at: time(after.createdAt), routed: null } } : value) }); }
        return required();
      }
      if (!await dependenciesHealthy(current, node.name, source.target, source.previous)) return current;
      const observed = node.quiescence !== null || node.baseline === null ? await bounded(Math.min(current.deadline, time() + 10_000), () => ports.services.observe(scope(current, node.name))) : source.previous === null ? undefined : await desired(node.baseline.action, node.name, source.previous, current.deadline);
      if (observed === undefined || observed.status === "unavailable") return current;
      if (observed.status !== "absent" && observed.status !== "owned") return hold(current, "service");
      if (node.baseline !== null && (observed.status !== "owned" || observed.id !== node.baseline.native.id || observed.version < node.baseline.native.version) ||
        node.quiescence === null && node.baseline !== null && observed.status === "owned" && (observed.specMatches !== true || observed.tombstone || observed.replicas !== 1) ||
        node.baseline === null && observed.status === "owned" && !clearedService(observed)) return hold(current, "service");
      if (node.quiescence !== null && (observed.status !== "owned" || !clearedService(observed) || ![null, "completed", "rollback_completed"].includes(observed.update))) return current;
      await execution(node.name, source.target).prepare(target, { ...scope(current, node.name), action: current.action, plan: managedServiceDigest(target), deadline: current.deadline, effect: "apply" }, observed.status === "owned" ? { id: observed.id, version: observed.version } : null); return required();
    }),
  });
};
