import { z } from "zod";
import { managedApplicationDigest, parseManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import { serviceEffectAction } from "../../contracts/swarm-service.ts";
import type { ServiceVersion } from "../../contracts/swarm-service.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import type { ManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import { managedServiceExecution, parseManagedServiceExecution } from "./managed-service-execution.ts";
import { managedServiceBarrier, parseManagedServiceBarrier } from "./managed-service-barrier.ts";
import { convergedService } from "./service-convergence.ts";
import { claimJournal } from "./journal-claim.ts";
import type { OperationJournal } from "./operation.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const native = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: positive }).strict().readonly();
const schema = z.object({ version: z.literal(1), action: z.unknown(), createdAt: positive, candidate: digest, previous: digest.nullable(),
  fences: z.array(z.object({ expected: native }).strict().readonly()).max(8).readonly(), baseline: native.nullable(), prior: z.array(native).max(64).readonly(), attempts: z.array(z.unknown()).max(8).readonly(), barrier: z.unknown().nullable(),
  phase: z.enum(["recovering", "complete", "held"]), reason: z.enum(["deadline", "runtime", "authorization", "attempts"]).nullable(), proof: z.object({ native, at: positive }).strict().readonly().nullable(),
}).strict().readonly();
export const parseManagedServiceCompensation = (input: unknown) => {
  const checked = schema.safeParse(input); if (!checked.success) throw new Error("invalid managed service compensation"); const raw = checked.data;
  const action = parseManagedServiceAction(raw.action); if (!action.ok || action.value.effect !== "restore" || action.value.action !== `${action.value.incarnation}:${action.value.action.split(":")[1] ?? ""}`) throw new Error("invalid managed compensation identity");
  const attempts = Object.freeze(raw.attempts.map(parseManagedServiceExecution)); const barrier = raw.barrier === null ? null : parseManagedServiceBarrier(raw.barrier);
  const expected = [...raw.fences.map((fence) => fence.expected), ...raw.prior, ...(raw.baseline === null ? [] : [raw.baseline]), ...attempts.flatMap((attempt) => attempt.expected === null ? Object.freeze([]) : Object.freeze([attempt.expected]))];
  if (raw.createdAt >= action.value.deadline || action.value.deadline - raw.createdAt > 90_000 || raw.baseline !== null && raw.previous === null ||
    raw.baseline === null && (attempts.length !== 0 || raw.fences.length !== 0) || expected.some((item) => item.id !== expected[0]?.id) ||
    attempts.some((attempt, index) => attempt.mode !== "apply" || attempt.action.action !== serviceEffectAction(action.value.action, "restore", index + 1) || attempt.action.effect !== "restore" || attempt.action.plan !== action.value.plan || attempt.action.deadline !== action.value.deadline ||
      attempt.action.app !== action.value.app || attempt.action.service !== action.value.service || attempt.action.incarnation !== action.value.incarnation || attempt.action.dataOwner !== action.value.dataOwner || attempt.createdAt < raw.createdAt || attempt.expected === null) ||
    barrier !== null && (barrier.action.app !== action.value.app || barrier.action.service !== action.value.service || barrier.action.incarnation !== action.value.incarnation || barrier.action.dataOwner !== action.value.dataOwner || barrier.action.action !== action.value.action || barrier.action.deadline !== action.value.deadline || barrier.createdAt < raw.createdAt) ||
    (raw.phase === "held") !== (raw.reason !== null) || (raw.phase === "complete") !== (raw.proof !== null) ||
    raw.proof !== null && (raw.proof.at < raw.createdAt || raw.proof.at >= action.value.deadline || expected.some((item) => item.id !== raw.proof?.native.id || item.version >= raw.proof.native.version) ||
      (raw.baseline === null ? barrier?.phase !== "complete" || barrier.proof?.native.id !== raw.proof.native.id || barrier.proof.native.version > raw.proof.native.version : attempts.at(-1)?.phase !== "converged" || attempts.at(-1)?.verified?.native.id !== raw.proof.native.id || (attempts.at(-1)?.verified?.native.version ?? Infinity) > raw.proof.native.version))) throw new Error("inconsistent managed compensation evidence");
  return Object.freeze({ ...raw, action: action.value, attempts, barrier });
};
export type ManagedServiceCompensation = ReturnType<typeof parseManagedServiceCompensation>;
type Ports = { readonly now: () => number; readonly read: (digest: string) => Promise<string>; readonly retain: (bytes: string) => Promise<string>;
  readonly services: ManagedWorkloadPort;
  /** Parent has fenced competing jobs/writers and retains the entire recovery reservation. */
  readonly authorize: (state: ManagedServiceCompensation, action: ManagedServiceAction) => Promise<boolean>;
};
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Compensates one consumer or scrubs a new-only workload. Never promotes a release, deletes data or releases capacity. */
export const managedServiceCompensation = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "managed compensation already has an owner");
  // eslint-disable-next-line functional/no-let -- private journal writer serialization
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- uncertain persistence requires reopening
  let poisoned = false;
  const serial = <T>(call: () => Promise<T>) => { const result = pending.then(() => { if (poisoned) throw new Error("managed compensation write is uncertain; reopen"); return call(); }); pending = result.then(() => undefined, () => undefined); return result; };
  const children = new Map<number, ReturnType<typeof managedServiceExecution>>();
  // eslint-disable-next-line functional/no-let -- one barrier owner shares the parent's private view
  let barrierOwner: ReturnType<typeof managedServiceBarrier> | undefined;
  const time = (minimum = 1) => { const now = ports.now(); if (!Number.isSafeInteger(now) || now < minimum) throw new Error("managed compensation clock unavailable"); return now; };
  const load = async () => { const value = await journal.read(); return value === undefined ? undefined : parseManagedServiceCompensation(value); };
  const required = async () => { const value = await load(); if (value === undefined) throw new Error("managed compensation intent missing"); return value; };
  const write = async (input: ManagedServiceCompensation) => { const value = parseManagedServiceCompensation(input); try { await journal.write(value); } catch { poisoned = true; throw new Error("managed compensation write is uncertain; reopen"); } return value; };
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => { const left = deadline - time(); if (left <= 0) return undefined;
    const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, left);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); } finally { clearTimeout(timer); }
  };
  const validate = (state: ManagedServiceCompensation, candidate: ManagedApplicationPlan, previous: ManagedApplicationPlan | null) => {
    const target = candidate.services[state.action.service]; const before = previous?.services[state.action.service]; const selected = before ?? target;
    if (selected?.owner.app !== state.action.app || selected.owner.incarnation !== state.action.incarnation || selected.owner.dataOwner !== state.action.dataOwner || managedServiceDigest(selected) !== state.action.plan ||
      (previous === null) !== (state.previous === null) || previous !== null && (!same(candidate.infrastructure.ownership, previous.infrastructure.ownership) || !same(candidate.host, previous.host) || !same(candidate.infrastructure.overlay, previous.infrastructure.overlay)) ||
      before?.role === "retained-dependency" || before !== undefined && target?.role === "retained-dependency" || (before === undefined) !== (state.baseline === null) ||
      before !== undefined && (!candidate.rollout.rollback_compatible || previous?.routes.some((route) => !candidate.hosts.includes(route.host)) || Object.values(before.inputs.environment).some((binding) => binding.kind === "secret" && !candidate.secrets.includes(binding.key)))) throw new Error("managed compensation plan scope or recovery grants disagree");
    return Object.freeze({ candidate, previous, target, before, selected });
  };
  const plans = async (state: ManagedServiceCompensation) => {
    const read = async (digest: string) => { const bytes = await bounded(Math.min(state.action.deadline, time() + 10_000), () => ports.read(digest)); if (bytes === undefined) throw new Error("managed compensation plan unavailable"); const value: unknown = JSON.parse(bytes); const parsed = parseManagedApplicationPlan(value);
      if (!parsed.ok || JSON.stringify(parsed.value) !== bytes || managedApplicationDigest(parsed.value) !== digest) throw new Error("managed compensation plan integrity failed"); return parsed.value; };
    return validate(state, await read(state.candidate), state.previous === null ? null : await read(state.previous));
  };
  const child = (index: number, context: ManagedApplicationPlan) => {
    const old = children.get(index); if (old !== undefined) return old;
    const owner = managedServiceExecution({ read: async () => (await required()).attempts[index], write: async (input: unknown) => { const state = await required(); const value = parseManagedServiceExecution(input); if (state.phase !== "recovering" || index > state.attempts.length) throw new Error("managed restore slot lost ownership"); await write({ ...state, attempts: index === state.attempts.length ? [...state.attempts, value] : state.attempts.map((attempt, position) => position === index ? value : attempt) }); } },
      { ...ports, runtime: { apply: (action, expected, service) => ports.services.apply(action, expected, service, context), observeDesired: (action, service) => ports.services.observeDesired(action, service, context) }, authorize: async (attempt) => { const state = await required(); return state.phase === "recovering" && same(state.attempts.at(-1), attempt) && ports.authorize(state, attempt.action); } });
    // eslint-disable-next-line functional/immutable-data -- one owner for each immutable CAS attempt
    children.set(index, owner); return owner;
  };
  const barrier = () => {
    if (barrierOwner !== undefined) return barrierOwner;
    barrierOwner = managedServiceBarrier({ read: async () => (await required()).barrier ?? undefined, write: async (input: unknown) => { const state = await required(); if (state.phase !== "recovering") throw new Error("managed compensation barrier lost ownership"); await write({ ...state, barrier: parseManagedServiceBarrier(input) }); } }, { ...ports, runtime: ports.services, authorize: async (_barrier, action) => { const state = await required(); return state.phase === "recovering" && ports.authorize(state, action); } }); return barrierOwner;
  };
  const hold = (state: ManagedServiceCompensation, reason: "deadline" | "runtime" | "authorization" | "attempts") => write({ ...state, phase: "held", reason, proof: null });
  return Object.freeze({
    prepare: (candidate: ManagedApplicationPlan, previous: ManagedApplicationPlan | null, action: ManagedServiceAction, baseline: ServiceVersion | null, prior: readonly ServiceVersion[]) => {
      const checked = parseManagedApplicationPlan(candidate); const before = previous === null ? null : parseManagedApplicationPlan(previous); if (!checked.ok || before !== null && !before.ok) return Promise.reject(new Error("invalid managed compensation plans"));
      const request = parseManagedServiceCompensation({ version: 1, action, createdAt: action.deadline - 1, candidate: managedApplicationDigest(checked.value), previous: before === null ? null : managedApplicationDigest(before.value), baseline, prior, fences: [], attempts: [], barrier: null, phase: "recovering", reason: null, proof: null });
      const source = validate(request, checked.value, before === null ? null : before.value);
      if (source.before !== undefined && ports.services.fence === undefined) return Promise.reject(new Error("managed compensation requires metadata fencing capability"));
      return serial(async () => { const old = await load(); if (old !== undefined) { if (!same(old.action, request.action) || old.candidate !== request.candidate || old.previous !== request.previous || !same(old.baseline, request.baseline) || !same(old.prior, request.prior)) throw new Error("managed compensation intent conflicts"); return old; }
        const state = parseManagedServiceCompensation({ ...request, createdAt: time() });
        for (const plan of [source.candidate, ...(source.previous === null ? [] : [source.previous])]) if (await bounded(action.deadline, () => ports.retain(JSON.stringify(plan))) !== managedApplicationDigest(plan)) throw new Error("managed compensation retention failed");
        return write(state);
      });
    },
    read: () => serial(load),
    tick: () => serial(async () => {
      const state = await required(); if (state.phase !== "recovering") return state; if (time(state.createdAt) >= state.action.deadline) return hold(state, "deadline"); const source = await plans(state);
      const needsBarrier = source.before === undefined || source.target?.overlap === "forbidden" && source.before.overlap !== "forbidden";
      if (needsBarrier) {
        if (state.barrier === null) { const spec = source.target ?? source.selected; await barrier().prepare(spec, { ...state.action, plan: managedServiceDigest(spec), effect: "remove" }, [...state.prior, ...(state.baseline === null ? [] : [state.baseline])]); return required(); }
        if (state.barrier.phase === "held") return hold(state, "runtime");
        if (state.barrier.phase !== "complete") { await barrier().tick(); return required(); }
        if (source.before === undefined) { const proof = state.barrier.proof; if (proof === null) throw new Error("managed cleanup proof missing"); const at = time(state.createdAt); return at >= state.action.deadline ? hold(state, "deadline") : write({ ...state, phase: "complete", proof: { native: proof.native, at } }); }
      }
      if (source.previous === null || state.baseline === null) throw new Error("managed restoration baseline missing");
      const previous = source.previous; const before = source.before;
      const latest = state.attempts.at(-1);
      if (latest?.phase === "planned") { await child(state.attempts.length - 1, source.previous).tick(); return required(); }
      if (latest?.phase === "held" && latest.reason !== "runtime") return hold(state, latest.reason === "deadline" ? "deadline" : "authorization");
      const scope = { app: state.action.app, incarnation: state.action.incarnation, dataOwner: state.action.dataOwner, service: state.action.service };
      const observed = await bounded(Math.min(state.action.deadline, time() + 10_000), () => ports.services.observe(scope)); if (observed === undefined || observed.status === "unavailable") return state;
      const prior = [...state.fences.map((fence) => fence.expected), ...state.prior, state.baseline, ...state.attempts.flatMap((attempt) => attempt.expected === null ? Object.freeze([]) : Object.freeze([attempt.expected]))];
      if (observed.status !== "owned" || prior.some((item) => item.id !== observed.id || item.version > observed.version)) return hold(state, "runtime");
      if (latest?.phase === "observing") {
        const desired = await bounded(Math.min(state.action.deadline, time() + 10_000), () => ports.services.observeDesired(latest.action, before, previous));
        if (desired === undefined || desired.status === "unavailable") return state;
        // An accepted template must finish scheduling; never replace it merely because its task is still starting.
        if (desired.status === "owned" && desired.action === latest.action.action && desired.effect === "restore" && desired.plan === latest.action.plan && desired.specMatches === true) { await child(state.attempts.length - 1, previous).tick(); return required(); }
        if (latest.expected === null) return hold(state, "runtime");
        if (observed.version <= latest.expected.version) {
          if (ports.services.fence === undefined) return hold(state, "runtime");
          if (state.fences.length >= 8) return hold(state, "attempts");
          const action = { ...state.action, action: serviceEffectAction(state.action.action, "fence", state.fences.length + 1), effect: "fence" as const };
          if (await bounded(state.action.deadline, () => ports.authorize(state, action)) !== true) return hold(state, "authorization");
          if (time(state.createdAt) >= state.action.deadline) return hold(state, "deadline");
          // A fresh identity may race an uncertain fence at the same exact CAS; only one can advance it, and neither changes tasks.
          const intent = await write({ ...state, fences: [...state.fences, { expected: { id: observed.id, version: observed.version } }] });
          if (time(state.createdAt) >= state.action.deadline) return hold(intent, "deadline");
          const fence = ports.services.fence; const result = await bounded(state.action.deadline, () => fence(action, { id: observed.id, version: observed.version }));
          return result === "refused" ? hold(intent, "runtime") : intent;
        }
      }
      if (latest?.phase === "converged") {
        const desired = await bounded(Math.min(state.action.deadline, time() + 10_000), () => ports.services.observeDesired(latest.action, before, previous)); const at = time(state.createdAt);
        if (at >= state.action.deadline) return hold(state, "deadline");
        if (desired?.status !== "owned" || desired.id !== observed.id || prior.some((item) => item.version >= desired.version) || !convergedService(latest.action, desired)) return hold(state, "runtime");
        return write({ ...state, phase: "complete", proof: { native: { id: desired.id, version: desired.version }, at } });
      }
      if (latest !== undefined && (latest.expected === null || observed.version <= latest.expected.version)) return state;
      if (state.attempts.length >= 8) return hold(state, "attempts");
      const index = state.attempts.length; await child(index, source.previous).prepare(source.before, { ...state.action, action: serviceEffectAction(state.action.action, "restore", index + 1) }, { id: observed.id, version: observed.version }); return required();
    }),
  });
};
