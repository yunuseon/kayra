import { z } from "zod";
import { managedServiceDigest, parseManagedServicePlan } from "../../contracts/managed-service-plan.ts";
import type { ManagedServicePlan } from "../../contracts/managed-service-plan.ts";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { ManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { ServiceObservation, ServiceVersion, ServiceWrite } from "../../contracts/swarm-service.ts";
import { convergedService } from "./service-convergence.ts";
import { claimJournal } from "./journal-claim.ts";
import type { OperationJournal } from "./operation.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const native = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: positive }).strict().readonly();
const schema = z.object({ version: z.literal(1), mode: z.enum(["apply", "reactivate-retained"]).default("apply"), createdAt: positive,
  action: z.object({ app: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), service: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), incarnation: z.uuid(), dataOwner: z.uuid(),
    action: z.string().min(1).max(80), plan: z.string().regex(/^[a-f0-9]{64}$/), deadline: positive, effect: z.enum(["apply", "restore"]),
  }).strict().readonly(), expected: native.nullable(), phase: z.enum(["planned", "observing", "converged", "held"]),
  reason: z.enum(["deadline", "authorization", "runtime"]).nullable(), verified: z.object({ native, at: positive }).strict().readonly().nullable(),
}).strict().readonly();
export const parseManagedServiceExecution = (input: unknown) => {
  const parsed = schema.safeParse(input); if (!parsed.success) throw new Error("invalid managed service execution");
  const state = parsed.data;
  if (state.mode === "reactivate-retained" && (state.expected === null || state.action.effect !== "apply") || !parseManagedServiceAction(state.action).ok || state.createdAt >= state.action.deadline || state.action.deadline - state.createdAt > 90_000 ||
    (state.phase === "held") !== (state.reason !== null) || (state.phase === "converged") !== (state.verified !== null) ||
    state.verified !== null && (state.verified.at < state.createdAt || state.verified.at >= state.action.deadline ||
      state.expected !== null && (state.verified.native.id !== state.expected.id || state.verified.native.version <= state.expected.version))) throw new Error("inconsistent managed service execution");
  return state;
};
export type ManagedServiceExecution = ReturnType<typeof parseManagedServiceExecution>;
type Ports = {
  readonly now: () => number; readonly read: (digest: string) => Promise<string>; readonly retain: (bytes: string) => Promise<string>;
  /** The group owner checks its current lifecycle fence and synchronized host reservation. */
  readonly authorize: (state: ManagedServiceExecution, plan: ManagedServicePlan) => Promise<boolean>;
  /** Composition materializes ephemeral inputs inside these typed ports, never in decision state. */
  readonly runtime: {
    readonly observeDesired: (action: ManagedServiceAction, plan: ManagedServicePlan) => Promise<ServiceObservation>;
    readonly reactivate?: (action: ManagedServiceAction, expected: ServiceVersion, plan: ManagedServicePlan) => Promise<ServiceWrite>;
    readonly apply: (action: ManagedServiceAction, expected: ServiceVersion | null, plan: ManagedServicePlan) => Promise<ServiceWrite>;
  };
};

/** One group-owned apply/restore slot. Recovery observes an intent and never redispatches an uncertain write. No release promotion or admission is granted here. */
export const managedServiceExecution = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "managed service execution already has an owner");
  // eslint-disable-next-line functional/no-let -- serializes the parent's private journal view
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- a rejected synchronized write may have committed
  let poisoned = false;
  const serial = <T>(call: () => Promise<T>) => {
    const result = pending.then(() => { if (poisoned) throw new Error("managed service write is uncertain; reopen and reconcile"); return call(); });
    pending = result.then(() => undefined, () => undefined); return result;
  };
  const time = (minimum = 1) => { const now = ports.now(); if (!Number.isSafeInteger(now) || now < minimum) throw new Error("managed service clock is unavailable"); return now; };
  const load = async () => { const raw = await journal.read(); return raw === undefined ? undefined : parseManagedServiceExecution(raw); };
  const write = async (input: ManagedServiceExecution) => {
    const state = parseManagedServiceExecution(input);
    try { await journal.write(state); } catch { poisoned = true; throw new Error("managed service write is uncertain; reopen and reconcile"); }
    return state;
  };
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => {
    const left = deadline - time(); if (left <= 0) return undefined;
    const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, left);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); }
    finally { clearTimeout(timer); }
  };
  const description = async (state: ManagedServiceExecution) => {
    const bytes = await bounded(time() + 10_000, () => ports.read(state.action.plan));
    const parsed = bytes === undefined ? undefined : (() => { try { const value: unknown = JSON.parse(bytes); return parseManagedServicePlan(value); } catch { return undefined; } })();
    if (!parsed?.ok || bytes !== JSON.stringify(parsed.value) || managedServiceDigest(parsed.value) !== state.action.plan || parsed.value.owner.app !== state.action.app ||
      parsed.value.owner.incarnation !== state.action.incarnation || parsed.value.owner.dataOwner !== state.action.dataOwner || parsed.value.service !== state.action.service ||
      (state.mode === "reactivate-retained" ? parsed.value.role !== "retained-dependency" || state.expected === null || state.action.effect !== "apply" || ports.runtime.reactivate === undefined : parsed.value.role === "retained-dependency" && (state.expected !== null || state.action.effect !== "apply"))) throw new Error("managed service plan integrity failed");
    return parsed.value;
  };
  const hold = (state: ManagedServiceExecution, reason: "deadline" | "authorization" | "runtime") => write({ ...state, phase: "held", reason, verified: null });
  return Object.freeze({
    prepare: (input: ManagedServicePlan, action: ManagedServiceAction, expected: ServiceVersion | null, mode: "apply" | "reactivate-retained" = "apply") => {
      const checked = parseManagedServicePlan(input); if (!checked.ok) return Promise.reject(new Error("invalid managed service plan"));
      const plan = checked.value;
      const request = parseManagedServiceExecution({ version: 1, mode, createdAt: action.deadline - 1, action, expected, phase: "planned", reason: null, verified: null });
      if (managedServiceDigest(plan) !== request.action.plan || plan.owner.app !== request.action.app || plan.owner.incarnation !== request.action.incarnation ||
        plan.owner.dataOwner !== request.action.dataOwner || plan.service !== request.action.service || (request.mode === "reactivate-retained" ? plan.role !== "retained-dependency" || request.expected === null || request.action.effect !== "apply" || ports.runtime.reactivate === undefined : plan.role === "retained-dependency" && (request.expected !== null || request.action.effect !== "apply"))) return Promise.reject(new Error("managed service preparation scope disagrees"));
      return serial(async () => {
        const previous = await load();
        if (previous !== undefined) {
          if (previous.mode !== request.mode || JSON.stringify(previous.action) !== JSON.stringify(request.action) || JSON.stringify(previous.expected) !== JSON.stringify(request.expected)) throw new Error("managed service intent conflicts");
          await description(previous); return previous;
        }
        const state = parseManagedServiceExecution({ ...request, createdAt: time() });
        if (time() >= request.action.deadline) throw new Error("managed service deadline expired");
        if (await bounded(request.action.deadline, () => ports.retain(JSON.stringify(plan))) !== request.action.plan) throw new Error("managed service plan retention failed");
        return write(state);
      });
    },
    read: () => serial(load),
    tick: () => serial(async () => {
      const state = await load(); if (state === undefined) throw new Error("managed service intent is missing");
      const plan = await description(state); time(state.createdAt);
      if (state.phase === "converged" || state.phase === "held") return state;
      if (state.phase === "planned") {
        if (time(state.createdAt) >= state.action.deadline) return hold(state, "deadline");
        if (await bounded(state.action.deadline, () => ports.authorize(state, plan)) !== true) return hold(state, "authorization");
        if (time(state.createdAt) >= state.action.deadline) return hold(state, "deadline");
        const intent = await write({ ...state, phase: "observing" });
        if (time(state.createdAt) >= state.action.deadline) return hold(intent, "deadline");
        const result = await bounded(state.action.deadline, () => intent.mode === "reactivate-retained" ?
          intent.expected === null || ports.runtime.reactivate === undefined ? Promise.resolve("refused" as const) : ports.runtime.reactivate(intent.action, intent.expected, plan) :
          ports.runtime.apply(intent.action, intent.expected, plan));
        return result === "conflict" || result === "refused" ? hold(intent, "runtime") : intent;
      }
      // A diagnostic read after expiry cannot renew dispatch authority or certify late convergence.
      const observation = await bounded(time() + 10_000, () => ports.runtime.observeDesired(state.action, plan)); const now = time(state.createdAt);
      if (now >= state.action.deadline) return hold(state, "deadline");
      if (observation === undefined || observation.status === "unavailable" || observation.status === "absent") return state;
      if (observation.status !== "owned") return hold(state, "runtime");
      if (observation.action === state.action.action && observation.plan === state.action.plan && observation.effect === state.action.effect && convergedService(state.action, observation)) {
        if (state.expected !== null && (observation.id !== state.expected.id || observation.version <= state.expected.version)) return hold(state, "runtime");
        return write({ ...state, phase: "converged", verified: { native: { id: observation.id, version: observation.version }, at: now } });
      }
      return ["paused", "rollback_started", "rollback_paused", "rollback_completed"].includes(observation.update ?? "") ? hold(state, "runtime") : state;
    }),
  });
};
