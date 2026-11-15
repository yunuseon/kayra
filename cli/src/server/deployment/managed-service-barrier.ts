import { z } from "zod";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { ManagedServiceAction, ManagedServiceScope } from "../../contracts/managed-swarm-service.ts";
import { managedServiceDigest, parseManagedServicePlan } from "../../contracts/managed-service-plan.ts";
import type { ManagedServicePlan } from "../../contracts/managed-service-plan.ts";
import { serviceEffectAction } from "../../contracts/swarm-service.ts";
import type { ServiceObservation, ServiceVersion, ServiceWrite } from "../../contracts/swarm-service.ts";
import { clearedService } from "./service-convergence.ts";
import { claimJournal } from "./journal-claim.ts";
import type { OperationJournal } from "./operation.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const native = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: positive }).strict().readonly();
const step = z.object({ effect: z.enum(["remove", "scrub"]), attempt: positive.max(8), expected: native.nullable() }).strict().readonly();
const schema = z.object({ version: z.literal(1), createdAt: positive, action: z.unknown(),
  prior: z.array(native).max(32).readonly(), nativeId: z.string().regex(/^[a-z0-9]{25}$/).nullable(), steps: z.array(step).max(16).readonly(),
  phase: z.enum(["fencing", "complete", "held"]), reason: z.enum(["deadline", "runtime", "authorization", "attempts"]).nullable(),
  proof: z.object({ native, at: positive }).strict().readonly().nullable(),
}).strict().readonly();
export const parseManagedServiceBarrier = (input: unknown) => {
  const checked = schema.safeParse(input); if (!checked.success) throw new Error("invalid managed service barrier");
  const value = checked.data; const action = parseManagedServiceAction(value.action);
  if (!action.ok || action.value.effect !== "remove" || !new RegExp(`^${action.value.incarnation}:[1-9][0-9]*$`).test(action.value.action)) throw new Error("invalid managed service barrier authority");
  const state = Object.freeze({ ...value, action: action.value }); const previous = [...state.prior, ...state.steps.flatMap((item) => item.expected === null ? Object.freeze([]) : Object.freeze([item.expected]))];
  const proof = state.proof;
  if (state.createdAt >= state.action.deadline || state.action.deadline - state.createdAt > 90_000 ||
    previous.some((item) => item.id !== state.nativeId) ||
    state.steps.some((item, index) => item.attempt !== state.steps.slice(0, index).filter((before) => before.effect === item.effect).length + 1 ||
      item.effect === "remove" && state.steps.slice(0, index).some((before) => before.effect === "scrub") ||
      item.expected === null && (index !== 0 || item.effect !== "remove")) ||
    (state.phase === "held") !== (state.reason !== null) || (state.phase === "complete") !== (state.proof !== null) ||
    proof !== null && (state.steps.at(-1)?.effect !== "scrub" || proof.at < state.createdAt || proof.at >= state.action.deadline ||
      proof.native.id !== state.nativeId || previous.some((item) => item.version >= proof.native.version))) throw new Error("inconsistent managed service barrier");
  return state;
};
export type ManagedServiceBarrier = ReturnType<typeof parseManagedServiceBarrier>;
type Ports = {
  readonly now: () => number; readonly read: (digest: string) => Promise<string>; readonly retain: (bytes: string) => Promise<string>;
  /** The lifecycle owner allows quiescence/removal only after settling or fencing migrations and competing effects. */
  readonly authorize: (state: ManagedServiceBarrier, action: ManagedServiceAction) => Promise<boolean>;
  readonly runtime: {
    readonly observe: (scope: ManagedServiceScope) => Promise<ServiceObservation>;
    readonly tombstone: (action: ManagedServiceAction, expected: ServiceVersion | null, image: string) => Promise<ServiceWrite>;
  };
};
const terminal = new Set(["shutdown", "complete", "failed", "rejected", "remove", "orphaned"]);
const actionFor = (state: ManagedServiceBarrier, step: ManagedServiceBarrier["steps"][number]) => Object.freeze({ ...state.action, effect: step.effect, action: serviceEffectAction(state.action.action, step.effect, step.attempt) });

/** Group-owned zero-replica name barrier. Never deletes a native service or volume; no capacity is released by this component. */
export const managedServiceBarrier = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "managed service barrier already has an owner");
  // eslint-disable-next-line functional/no-let -- serializes the parent's private journal view
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- uncertain persistence requires a fresh handle
  let poisoned = false;
  const serial = <T>(call: () => Promise<T>) => { const result = pending.then(() => { if (poisoned) throw new Error("managed barrier write is uncertain; reopen and reconcile"); return call(); }); pending = result.then(() => undefined, () => undefined); return result; };
  const time = (minimum = 1) => { const now = ports.now(); if (!Number.isSafeInteger(now) || now < minimum) throw new Error("managed barrier clock is unavailable"); return now; };
  const load = async () => { const raw = await journal.read(); return raw === undefined ? undefined : parseManagedServiceBarrier(raw); };
  const write = async (input: ManagedServiceBarrier) => {
    const state = parseManagedServiceBarrier(input); try { await journal.write(state); } catch { poisoned = true; throw new Error("managed barrier write is uncertain; reopen and reconcile"); } return state;
  };
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => {
    const left = deadline - time(); if (left <= 0) return undefined;
    const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, left);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); } finally { clearTimeout(timer); }
  };
  const description = async (state: ManagedServiceBarrier) => {
    const bytes = await bounded(time() + 10_000, () => ports.read(state.action.plan));
    const parsed = bytes === undefined ? undefined : (() => { try { const raw: unknown = JSON.parse(bytes); return parseManagedServicePlan(raw); } catch { return undefined; } })();
    if (!parsed?.ok || bytes !== JSON.stringify(parsed.value) || managedServiceDigest(parsed.value) !== state.action.plan || parsed.value.owner.app !== state.action.app ||
      parsed.value.owner.incarnation !== state.action.incarnation || parsed.value.owner.dataOwner !== state.action.dataOwner || parsed.value.service !== state.action.service) throw new Error("managed barrier plan integrity failed");
    return parsed.value;
  };
  const hold = (state: ManagedServiceBarrier, reason: "deadline" | "runtime" | "authorization" | "attempts") => write({ ...state, phase: "held", reason, proof: null });
  const dispatch = async (state: ManagedServiceBarrier, effect: "remove" | "scrub", expected: ServiceVersion | null, image: string) => {
    const attempt = state.steps.filter((step) => step.effect === effect).length + 1;
    if (attempt > 8) return hold(state, "attempts");
    const step = Object.freeze({ effect, expected, attempt }); const action = actionFor(state, step);
    if (await bounded(state.action.deadline, () => ports.authorize(state, action)) !== true) return hold(state, "authorization");
    if (time(state.createdAt) >= state.action.deadline) return hold(state, "deadline");
    const intent = await write({ ...state, steps: [...state.steps, step] });
    if (time(state.createdAt) >= state.action.deadline) return hold(intent, "deadline");
    const result = await bounded(state.action.deadline, () => ports.runtime.tombstone(action, expected, image));
    return result === "refused" ? hold(intent, "runtime") : intent;
  };
  return Object.freeze({
    prepare: (input: ManagedServicePlan, requested: ManagedServiceAction, prior: readonly ServiceVersion[]) => {
      const plan = parseManagedServicePlan(input); if (!plan.ok) return Promise.reject(new Error("invalid managed barrier plan"));
      const ids = new Set(prior.map((item) => item.id));
      const request = parseManagedServiceBarrier({ version: 1, createdAt: requested.deadline - 1, action: requested, prior, nativeId: prior[0]?.id ?? null, steps: [], phase: "fencing", reason: null, proof: null });
      if (ids.size > 1 || managedServiceDigest(plan.value) !== request.action.plan || plan.value.owner.app !== request.action.app || plan.value.owner.incarnation !== request.action.incarnation ||
        plan.value.owner.dataOwner !== request.action.dataOwner || plan.value.service !== request.action.service) return Promise.reject(new Error("managed barrier scope disagrees"));
      return serial(async () => {
        const previous = await load();
        if (previous !== undefined) {
          if (JSON.stringify(previous.action) !== JSON.stringify(request.action) || JSON.stringify(previous.prior) !== JSON.stringify(request.prior)) throw new Error("managed barrier intent conflicts");
          await description(previous); return previous;
        }
        const state = parseManagedServiceBarrier({ ...request, createdAt: time() });
        if (await bounded(state.action.deadline, () => ports.retain(JSON.stringify(plan.value))) !== state.action.plan) throw new Error("managed barrier plan retention failed");
        return write(state);
      });
    },
    read: () => serial(load),
    tick: () => serial(async () => {
      const state = await load(); if (state === undefined) throw new Error("managed barrier intent is missing");
      const plan = await description(state); time(state.createdAt);
      if (state.phase !== "fencing") return state;
      const observed = await bounded(time() + 10_000, () => ports.runtime.observe({ app: state.action.app, service: state.action.service, incarnation: state.action.incarnation, dataOwner: state.action.dataOwner })); const now = time(state.createdAt);
      if (now >= state.action.deadline) return hold(state, "deadline");
      if (observed === undefined || observed.status === "unavailable") return state;
      const latest = state.steps.at(-1);
      if (observed.status === "absent") return state.nativeId !== null ? hold(state, "runtime") : latest === undefined ? dispatch(state, "remove", null, plan.image) : state;
      if (observed.status !== "owned") return hold(state, "runtime");
      if (state.nativeId === null) return write({ ...state, nativeId: observed.id });
      if (state.nativeId !== observed.id || state.prior.some((item) => item.version > observed.version)) return hold(state, "runtime");
      const expected = Object.freeze({ id: observed.id, version: observed.version });
      if (latest === undefined) return dispatch(state, "remove", expected, plan.image);
      const action = actionFor(state, latest);
      if (observed.action === action.action && observed.effect === action.effect && observed.plan === action.plan) {
        if (latest.effect === "scrub" && clearedService(observed)) {
          if ([...state.prior, ...state.steps.flatMap((item) => item.expected === null ? Object.freeze([]) : Object.freeze([item.expected]))].some((item) => item.version >= observed.version)) return hold(state, "runtime");
          return write({ ...state, phase: "complete", proof: { native: expected, at: now } });
        }
        if (observed.tombstone && observed.replicas === 0 && observed.tasks.every((task) => terminal.has(task.state))) return dispatch(state, "scrub", expected, plan.image);
        return state;
      }
      // An unchanged version may still receive the recorded request. Wait; never redispatch that CAS intent.
      if (latest.expected !== null && observed.version <= latest.expected.version) return state;
      if (latest.effect === "scrub") {
        const own = state.steps.some((step) => { const prior = actionFor(state, step); return prior.action === observed.action && prior.effect === observed.effect && prior.plan === observed.plan; });
        return own ? dispatch(state, "scrub", expected, plan.image) : hold(state, "runtime");
      }
      return dispatch(state, "remove", expected, plan.image);
    }),
  });
};
