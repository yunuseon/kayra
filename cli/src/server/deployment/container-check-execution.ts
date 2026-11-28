import { z } from "zod";
import { containerCheckDigest, parseContainerCheckPlan } from "../../contracts/container-check.ts";
import type { ContainerCheckPlan, ContainerCheckPort } from "../../contracts/container-check.ts";
import { claimJournal } from "./journal-claim.ts";
import type { OperationJournal } from "./operation.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({ version: z.literal(1), plan: z.string().regex(/^[a-f0-9]{64}$/), createdAt: positive, deadline: positive, startDeadline: positive,
  creates: z.number().int().min(0).max(8), id: z.string().regex(/^[a-f0-9]{64}$/).nullable(), executionDeadline: positive.nullable(),
  phase: z.enum(["planned", "creating", "created", "starting", "observing", "complete", "held"]), reason: z.enum(["deadline", "authorization", "runtime", "unknown-start", "attempts"]).nullable(),
  acknowledgedAt: positive.nullable(), runningAt: positive.nullable(), evidence: z.object({ exitCode: z.number().int(), at: positive }).strict().readonly().nullable(),
}).strict().readonly();
export const parseContainerCheckExecution = (input: unknown) => {
  const state = schema.parse(input);
  if (state.createdAt >= state.startDeadline || state.startDeadline > state.deadline || state.startDeadline > state.createdAt + 90_000 || state.deadline - state.createdAt > 86_490_000 ||
    state.executionDeadline !== null && (state.executionDeadline <= state.createdAt || state.executionDeadline > state.deadline) ||
    state.phase === "planned" && (state.creates !== 0 || state.id !== null) || state.phase === "creating" && (state.creates === 0 || state.id !== null) ||
    ["created", "starting", "observing", "complete"].includes(state.phase) && (state.id === null || state.creates === 0) ||
    ["starting", "observing", "complete"].includes(state.phase) && state.executionDeadline === null ||
    ["planned", "creating", "created"].includes(state.phase) && (state.executionDeadline !== null || state.acknowledgedAt !== null || state.runningAt !== null) ||
    (state.phase === "held") !== (state.reason !== null) || (state.phase === "complete") !== (state.evidence !== null) ||
    [state.acknowledgedAt, state.runningAt].some((at) => at !== null && (state.id === null || state.executionDeadline === null || at < state.createdAt || at >= state.executionDeadline)) ||
    state.evidence !== null && (state.executionDeadline === null || state.evidence.at < state.createdAt || state.evidence.at >= state.executionDeadline || state.acknowledgedAt === null && state.runningAt === null || [state.acknowledgedAt, state.runningAt].some((at) => at !== null && at > (state.evidence?.at ?? 0)))) throw new Error("inconsistent application check execution");
  return state;
};
export type ContainerCheckExecution = ReturnType<typeof parseContainerCheckExecution>;
type Ports = { readonly now: () => number; readonly read: (digest: string) => Promise<string>; readonly retain: (bytes: string) => Promise<string>; readonly runtime: ContainerCheckPort;
  readonly authorize: (state: ContainerCheckExecution, plan: ContainerCheckPlan, effect: "create" | "start") => Promise<boolean>;
};

/** Executes inside a pinned admitted task. Held/expired does not claim the process stopped: the lifecycle owner must fence its container before settlement. */
export const containerCheckExecution = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "application check already has an owner");
  // eslint-disable-next-line functional/no-let -- serializes private check execution state
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- uncertain synchronized writes require reopen
  let poisoned = false;
  const serial = <T>(call: () => Promise<T>) => { const result = pending.then(() => { if (poisoned) throw new Error("application check write is uncertain; reopen"); return call(); }); pending = result.then(() => undefined, () => undefined); return result; };
  const time = (minimum = 1) => { const now = ports.now(); if (!Number.isSafeInteger(now) || now < minimum) throw new Error("application check clock unavailable"); return now; };
  const load = async () => { const value = await journal.read(); return value === undefined ? undefined : parseContainerCheckExecution(value); };
  const write = async (input: ContainerCheckExecution) => { const state = parseContainerCheckExecution(input); try { await journal.write(state); } catch { poisoned = true; throw new Error("application check write is uncertain; reopen"); } return state; };
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => { const left = deadline - time(); if (left <= 0) return undefined; const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, left);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); } finally { clearTimeout(timer); }
  };
  const hold = (state: ContainerCheckExecution, reason: "deadline" | "authorization" | "runtime" | "unknown-start" | "attempts") => write({ ...state, phase: "held", reason, evidence: null });
  const description = async (state: ContainerCheckExecution) => {
    const bytes = await bounded(time() + 10_000, () => ports.read(state.plan)); if (bytes === undefined) throw new Error("application check plan unavailable"); const raw: unknown = JSON.parse(bytes); const checked = parseContainerCheckPlan(raw);
    if (!checked.ok || JSON.stringify(checked.value) !== bytes || containerCheckDigest(checked.value) !== state.plan || checked.value.deadline !== state.deadline) throw new Error("application check plan integrity failed"); return checked.value;
  };
  return Object.freeze({
    prepare: (input: ContainerCheckPlan) => { const checked = parseContainerCheckPlan(input); if (!checked.ok) return Promise.reject(new Error(checked.error)); const plan = checked.value;
      return serial(async () => { const previous = await load(); if (previous !== undefined) { if (previous.plan !== containerCheckDigest(plan)) throw new Error("application check intent conflicts"); return previous; }
        const now = time(); const state = parseContainerCheckExecution({ version: 1, plan: containerCheckDigest(plan), createdAt: now, deadline: plan.deadline, startDeadline: Math.min(plan.deadline, now + 90_000), creates: 0, id: null, executionDeadline: null, phase: "planned", reason: null, acknowledgedAt: null, runningAt: null, evidence: null });
        if (await bounded(state.startDeadline, () => ports.retain(JSON.stringify(plan))) !== state.plan) throw new Error("application check plan retention failed"); return write(state);
      });
    },
    read: () => serial(load),
    tick: () => serial(async () => {
      const state = await load(); if (state === undefined) throw new Error("application check intent missing"); if (state.phase === "complete" || state.phase === "held") return state;
      const now = time(state.createdAt); if (now >= (state.executionDeadline ?? state.startDeadline)) return hold(state, "deadline"); const plan = await description(state);
      if (state.phase === "planned" || state.phase === "creating") {
        if (state.creates >= 8) return hold(state, "attempts");
        if (await bounded(state.startDeadline, () => ports.authorize(state, plan, "create")) !== true) return hold(state, "authorization");
        if (time(state.createdAt) >= state.startDeadline) return hold(state, "deadline");
        const intent = await write({ ...state, phase: "creating", creates: state.creates + 1 });
        if (time(state.createdAt) >= intent.startDeadline) return hold(intent, "deadline");
        // Unknown earlier Create IDs can never be started: only the synchronized returned ID is passed to Start.
        const result = await bounded(state.startDeadline, () => ports.runtime.create(plan));
        if (result?.status === "refused") return hold(intent, "runtime");
        return result?.status === "created" ? write({ ...intent, phase: "created", id: result.id }) : intent;
      }
      if (state.id === null) throw new Error("application check exec identity missing"); const id = state.id;
      if (state.phase === "created") {
        const observed = await bounded(state.startDeadline, () => ports.runtime.observe(plan, id)); if (observed === undefined || observed.status === "unavailable") return state;
        if (observed.status !== "owned" || observed.id !== id || observed.running) return hold(state, "runtime");
        if (await bounded(state.startDeadline, () => ports.authorize(state, plan, "start")) !== true) return hold(state, "authorization");
        const at = time(state.createdAt); if (at >= state.startDeadline) return hold(state, "deadline");
        const intent = await write({ ...state, phase: "starting", executionDeadline: Math.min(state.deadline, at + plan.timeoutSeconds * 1000) }); const deadline = intent.executionDeadline;
        if (deadline === null) throw new Error("application check execution deadline missing"); if (time(state.createdAt) >= deadline) return hold(intent, "deadline");
        const result = await bounded(deadline, () => ports.runtime.start(plan, id, deadline)); const acknowledgedAt = time(state.createdAt);
        if (acknowledgedAt >= deadline) return hold(intent, "deadline"); if (result === "refused") return hold(intent, "runtime");
        return result === "acknowledged" ? write({ ...intent, phase: "observing", acknowledgedAt }) : intent;
      }
      const observed = await bounded(Math.min(state.executionDeadline ?? state.deadline, time() + 10_000), () => ports.runtime.observe(plan, id)); const at = time(state.createdAt);
      if (at >= (state.executionDeadline ?? state.deadline)) return hold(state, "deadline"); if (observed === undefined || observed.status === "unavailable") return state;
      if (observed.status !== "owned" || observed.id !== id) return hold(state, "unknown-start");
      if (observed.running) return write({ ...state, phase: "observing", runningAt: state.runningAt ?? at });
      if (state.acknowledgedAt === null && state.runningAt === null) return hold(state, "unknown-start");
      return observed.exitCode === null ? hold(state, "runtime") : write({ ...state, phase: "complete", evidence: { exitCode: observed.exitCode, at } });
    }),
  });
};
