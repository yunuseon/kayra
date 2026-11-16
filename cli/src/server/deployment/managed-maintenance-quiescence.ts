import { createHash } from "node:crypto";
import { z } from "zod";
import { parseManagedApplicationPlan, managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { ManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import { managedServiceBarrier, parseManagedServiceBarrier } from "./managed-service-barrier.ts";
import { clearedService } from "./service-convergence.ts";
import { claimJournal } from "./journal-claim.ts";
import type { OperationJournal } from "./operation.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const native = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: positive }).strict().readonly();
const baseline = z.object({ name: z.string().max(48), action: z.unknown(), native, prior: z.array(native).max(31).readonly() }).strict().readonly();
const request = z.object({ candidate: z.unknown(), previous: z.unknown().nullable(), baselines: z.array(baseline).max(32).readonly(), run: z.uuid(), action: z.string().max(80), startedAt: positive }).strict().readonly();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const description = (input: unknown) => {
  const raw = request.parse(input); const target = parseManagedApplicationPlan(raw.candidate); const old = raw.previous === null ? null : parseManagedApplicationPlan(raw.previous);
  if (!target.ok || old !== null && !old.ok) throw new Error("invalid maintenance application plan");
  const candidate = target.value; const previous = old?.value ?? null; const owner = candidate.infrastructure.ownership;
  if (candidate.rollout.strategy !== "maintenance" || !candidate.grants.maintenance ||
    !new RegExp(`^${owner.incarnation}:[1-9][0-9]*$`).test(raw.action) || !Number.isSafeInteger(Number(raw.action.split(":")[1])) ||
    previous !== null && (!same(owner, previous.infrastructure.ownership) || !same(candidate.host, previous.host) || !same(candidate.infrastructure.overlay, previous.infrastructure.overlay))) throw new Error("maintenance authority disagrees");
  const consumers = Object.values(previous?.services ?? {}).filter((service) => service.role !== "retained-dependency");
  if (raw.baselines.length !== consumers.length || new Set(raw.baselines.map((node) => node.name)).size !== raw.baselines.length ||
    Object.values(previous?.services ?? {}).some((service) => { const target = candidate.services[service.service]; return service.role === "retained-dependency" ? target === undefined || managedServiceDigest(service) !== managedServiceDigest(target) : target?.role === "retained-dependency"; })) throw new Error("maintenance service coverage disagrees");
  const baselines = raw.baselines.map((node) => {
    const action = parseManagedServiceAction(node.action); const service = previous?.services[node.name];
    if (!action.ok || service === undefined || service.role === "retained-dependency" || action.value.app !== owner.app || action.value.incarnation !== owner.incarnation || action.value.dataOwner !== owner.dataOwner || action.value.service !== node.name || action.value.plan !== managedServiceDigest(service) ||
      action.value.effect !== "apply" && action.value.effect !== "restore" || Number(action.value.action.split(":")[1]) >= Number(raw.action.split(":")[1]) || node.prior.some((prior) => prior.id !== node.native.id || prior.version > node.native.version)) throw new Error("maintenance baseline disagrees");
    return Object.freeze({ ...node, action: action.value });
  });
  return Object.freeze({ ...raw, candidate, previous, baselines: Object.freeze(baselines) });
};
const schema = z.object({ version: z.literal(1), source: digest, plan: digest, previous: digest.nullable(), app: z.string(), incarnation: z.uuid(), dataOwner: z.uuid(), run: z.uuid(), action: z.string(), createdAt: positive, deadline: positive,
  phase: z.enum(["quiescing", "complete", "held"]), reason: z.enum(["deadline", "runtime", "authorization"]).nullable(), verifiedAt: positive.nullable(),
  nodes: z.array(z.object({ name: z.string(), plan: digest, baseline: native, prior: z.array(native).max(31).readonly(), child: z.unknown().nullable() }).strict().readonly()).max(32).readonly(),
}).strict().readonly();
export const parseManagedMaintenanceQuiescence = (input: unknown) => {
  const raw = schema.parse(input); const at = raw.verifiedAt; const nodes = Object.freeze(raw.nodes.map((node) => {
    const child = node.child === null ? null : parseManagedServiceBarrier(node.child);
    if (child !== null && (child.action.app !== raw.app || child.action.incarnation !== raw.incarnation || child.action.dataOwner !== raw.dataOwner || child.action.service !== node.name || child.action.plan !== node.plan || child.action.action !== raw.action + ":quiesce" || child.action.deadline !== raw.deadline || child.createdAt < raw.createdAt || !same(child.prior, [node.baseline, ...node.prior]))) throw new Error("maintenance child evidence disagrees");
    return Object.freeze({ ...node, child });
  }));
  if (raw.deadline !== raw.createdAt + 90_000 || !new RegExp(`^${raw.incarnation}:[1-9][0-9]*$`).test(raw.action) || !Number.isSafeInteger(Number(raw.action.split(":")[1])) || raw.incarnation === raw.dataOwner || new Set(nodes.map((node) => node.name)).size !== nodes.length ||
    (raw.phase === "held") !== (raw.reason !== null) || (raw.phase === "complete") !== (raw.verifiedAt !== null) || raw.verifiedAt !== null && (raw.verifiedAt < raw.createdAt || raw.verifiedAt >= raw.deadline || nodes.some((node) => node.child?.phase !== "complete" || (node.child.proof?.at ?? Infinity) > (at ?? Infinity)))) throw new Error("inconsistent maintenance quiescence");
  return Object.freeze({ ...raw, nodes });
};
export type ManagedMaintenanceQuiescence = ReturnType<typeof parseManagedMaintenanceQuiescence>;
/** Structural binding only; the caller must independently reobserve the recorded barriers before effects. */
export const managedMaintenanceSnapshot = (input: unknown) => {
  const raw = z.object({ certificate: z.unknown(), source: z.unknown() }).strict().parse(input);
  const certificate = parseManagedMaintenanceQuiescence(raw.certificate); const value = description(raw.source);
  const owner = value.candidate.infrastructure.ownership;
  if (hash(JSON.stringify(value)) !== certificate.source || managedApplicationDigest(value.candidate) !== certificate.plan || (value.previous === null ? null : managedApplicationDigest(value.previous)) !== certificate.previous || value.action !== certificate.action || value.run !== certificate.run || value.startedAt !== certificate.createdAt ||
    owner.app !== certificate.app || owner.incarnation !== certificate.incarnation || owner.dataOwner !== certificate.dataOwner || !same(value.baselines.map((node) => Object.freeze({ name: node.name, plan: node.action.plan, baseline: node.native, prior: node.prior })), certificate.nodes.map(({ name, plan, baseline, prior }) => Object.freeze({ name, plan, baseline, prior })))) throw new Error("maintenance snapshot integrity failed");
  return Object.freeze({ certificate, source: value });
};
type Ports = { readonly now: () => number; readonly read: (digest: string) => Promise<string>; readonly retain: (bytes: string) => Promise<string>; readonly services: Pick<ManagedWorkloadPort, "observe" | "tombstone">;
  /** Root owns the pending reservation and has fenced all competing writers, jobs and check executions. */
  readonly authorize: (state: ManagedMaintenanceQuiescence, action: ManagedServiceAction | null) => Promise<boolean>;
};

/** Stops consumers before maintenance migrations. Does not run jobs, settle capacity, stop retained dependencies or promote releases. */
export const managedMaintenanceQuiescence = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "maintenance quiescence already has an owner");
  // eslint-disable-next-line functional/no-let -- one serialized parent writer owns every child view
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- uncertain synchronization invalidates this handle
  let poisoned = false;
  const serial = <T>(call: () => Promise<T>) => { const result = pending.then(() => { if (poisoned) throw new Error("maintenance write uncertain; reopen"); return call(); }); pending = result.then(() => undefined, () => undefined); return result; };
  const time = () => { const at = ports.now(); if (!Number.isSafeInteger(at) || at < 1) throw new Error("maintenance clock unavailable"); return at; };
  const load = async () => { const raw = await journal.read(); return raw === undefined ? undefined : parseManagedMaintenanceQuiescence(raw); };
  const required = async () => { const state = await load(); if (state === undefined) throw new Error("maintenance intent missing"); return state; };
  const write = async (input: ManagedMaintenanceQuiescence) => { const state = parseManagedMaintenanceQuiescence(input); try { await journal.write(state); } catch { poisoned = true; throw new Error("maintenance write uncertain; reopen"); } return state; };
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => { const left = deadline - time(); if (left <= 0) return undefined; const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, left);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); } finally { clearTimeout(timer); }
  };
  const hold = (state: ManagedMaintenanceQuiescence, reason: "deadline" | "runtime" | "authorization") => write({ ...state, phase: "held", reason, verifiedAt: null });
  const source = async (state: ManagedMaintenanceQuiescence) => {
    const bytes = await bounded(time() + 10_000, () => ports.read(state.source)); if (bytes === undefined || hash(bytes) !== state.source) throw new Error("maintenance source unavailable");
    const value = description(JSON.parse(bytes)); if (bytes !== JSON.stringify(value) || managedApplicationDigest(value.candidate) !== state.plan || (value.previous === null ? null : managedApplicationDigest(value.previous)) !== state.previous || value.action !== state.action || value.run !== state.run || value.startedAt !== state.createdAt ||
      !same(value.candidate.infrastructure.ownership, { version: 1, app: state.app, incarnation: state.incarnation, dataOwner: state.dataOwner }) || !same(value.baselines.map((node) => Object.freeze({ name: node.name, plan: node.action.plan, baseline: node.native, prior: node.prior })), state.nodes.map(({ name, plan, baseline, prior }) => Object.freeze({ name, plan, baseline, prior })))) throw new Error("maintenance source integrity failed"); return value;
  };
  const children = new Map<string, ReturnType<typeof managedServiceBarrier>>();
  const child = (name: string) => {
    const existing = children.get(name); if (existing !== undefined) return existing;
    const owner = managedServiceBarrier({ read: async () => (await required()).nodes.find((node) => node.name === name)?.child ?? undefined, write: async (input) => { const state = await required(); if (state.phase !== "quiescing") throw new Error("maintenance child lost ownership"); const parsed = parseManagedServiceBarrier(input); await write({ ...state, nodes: state.nodes.map((node) => node.name === name ? { ...node, child: parsed } : node) }); } },
      { ...ports, runtime: ports.services, authorize: async (_, action) => ports.authorize(await required(), action) });
    // eslint-disable-next-line functional/immutable-data -- caches a single private view per owned child
    children.set(name, owner); return owner;
  };
  return Object.freeze({
    prepare: (input: unknown) => { const value = description(input); const bytes = JSON.stringify(value); const owner = value.candidate.infrastructure.ownership; return serial(async () => {
      const old = await load(); if (old !== undefined) { if (old.source !== hash(bytes)) throw new Error("maintenance intent conflicts"); await source(old); return old; }
      const now = time(); if (now < value.startedAt || now >= value.startedAt + 90_000) throw new Error("maintenance scheduling deadline expired");
      const state = parseManagedMaintenanceQuiescence({ version: 1, source: hash(bytes), plan: managedApplicationDigest(value.candidate), previous: value.previous === null ? null : managedApplicationDigest(value.previous), app: owner.app, incarnation: owner.incarnation, dataOwner: owner.dataOwner, run: value.run, action: value.action, createdAt: value.startedAt, deadline: value.startedAt + 90_000, phase: "quiescing", reason: null, verifiedAt: null,
        nodes: value.baselines.map((node) => Object.freeze({ name: node.name, plan: node.action.plan, baseline: node.native, prior: node.prior, child: null })) });
      if (await bounded(state.deadline, () => ports.retain(bytes)) !== state.source) throw new Error("maintenance source retention failed"); return write(state);
    }); },
    read: () => serial(load),
    tick: () => serial(async () => {
      const state = await required(); const value = await source(state); if (time() < state.createdAt) throw new Error("maintenance clock moved backwards"); if (state.phase !== "quiescing") return state; if (time() >= state.deadline) return hold(state, "deadline");
      if (await bounded(state.deadline, () => ports.authorize(state, null)) !== true) return hold(state, "authorization");
      const unfinished = state.nodes.filter((node) => node.child?.phase !== "complete");
      if (unfinished.some((node) => node.child?.phase === "held")) return hold(state, "runtime");
      const selected = unfinished.find((node) => !unfinished.some((other) => value.previous?.services[other.name]?.dependencies.some((dependency) => dependency.service === node.name)));
      if (selected !== undefined) {
        const service = value.previous?.services[selected.name]; if (service === undefined) throw new Error("maintenance previous service missing");
        if (selected.child === null) await child(selected.name).prepare(service, { app: state.app, incarnation: state.incarnation, dataOwner: state.dataOwner, service: selected.name, action: state.action, plan: selected.plan, effect: "remove", deadline: state.deadline }, [selected.baseline, ...selected.prior], "quiesce"); else await child(selected.name).tick(); return required();
      }
      if (unfinished.length !== 0) throw new Error("maintenance dependency scheduler inconsistent");
      for (const node of state.nodes) {
        const observed = await bounded(state.deadline, () => ports.services.observe({ app: state.app, incarnation: state.incarnation, dataOwner: state.dataOwner, service: node.name }));
        const barrier = node.child; const latest = barrier?.steps.at(-1);
        if (observed?.status !== "owned" || !clearedService(observed) || observed.id !== barrier?.proof?.native.id || observed.version < barrier.proof.native.version || latest?.effect !== "scrub" || observed.action !== state.action + ":quiesce:scrub:" + String(latest.attempt) || observed.plan !== node.plan || observed.effect !== "scrub") return hold(state, "runtime");
      }
      if (await bounded(state.deadline, () => ports.authorize(state, null)) !== true) return hold(state, "authorization");
      const at = time(); if (at >= state.deadline) return hold(state, "deadline"); return write({ ...state, phase: "complete", verifiedAt: at });
    }),
  });
};
