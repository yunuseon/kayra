import { z } from "zod";
import { jobPlanDigest, parseJobPlan, parseJobScope } from "../../contracts/one-shot-job.ts";
import type { JobPlan, JobPort } from "../../contracts/one-shot-job.ts";
import { claimJournal } from "./journal-claim.ts";
import type { OperationJournal } from "./operation.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[0-9a-f]{64}$/);
const evidence = z.object({ kind: z.enum(["succeeded", "failed", "unknown", "not-started"]), id: id.nullable(),
  exitCode: z.number().int().nullable(), observedAt: positive, probe: z.enum(["applied", "not-applied", "unknown"]).nullable().default(null),
  finishedAt: positive.nullable().default(null),
}).strict().readonly();
const schema = z.object({ version: z.literal(1), plan: id, scope: z.unknown(), createdAt: positive, deadline: positive,
  phase: z.enum(["create-intent", "start-intent", "observing", "fencing", "complete", "held"]),
  container: id.nullable(), evidence: evidence.nullable(), fenceDeadline: positive.nullable(), barrier: id.nullable(),
  fenceTargets: z.array(id).max(8).readonly().default(Object.freeze([])),
  cancelRequestedAt: positive.optional(), executionDeadline: positive.nullable().optional(), expiry: z.enum(["scheduling", "execution"]).nullable().optional(),
}).strict().readonly();

export const parseJobExecution = (input: unknown) => {
  const parsed = schema.safeParse(input); if (!parsed.success) throw new Error("invalid one-shot execution record");
  const raw = parsed.data;
  // Legacy records keep their original ceiling; recovery never mints a new execution window.
  const priorDeadline = raw.container === null || raw.evidence?.kind === "not-started" ? null : raw.deadline;
  const priorExpiry: "scheduling" | "execution" | null = raw.evidence === null || raw.evidence.observedAt < raw.deadline ? null
    : raw.evidence.kind === "not-started" ? "scheduling" : "execution";
  const value = { ...raw, executionDeadline: raw.executionDeadline === undefined ? priorDeadline : raw.executionDeadline,
    expiry: raw.expiry === undefined ? priorExpiry : raw.expiry };
  const scope = parseJobScope(value.scope);
  if (!scope.ok || value.cancelRequestedAt !== undefined && (value.cancelRequestedAt < value.createdAt || value.evidence !== null && value.cancelRequestedAt > value.evidence.observedAt) || value.createdAt >= value.deadline || new Set(value.fenceTargets).size !== value.fenceTargets.length || value.fenceTargets.includes(value.container ?? "") ||
    (value.executionDeadline !== null && (value.executionDeadline <= value.createdAt || value.executionDeadline > value.deadline)) ||
    (value.expiry === "scheduling" && (value.executionDeadline !== null || value.evidence?.kind !== "not-started")) ||
    (value.expiry === "execution" && value.executionDeadline === null) ||
    (value.fenceTargets.length > 0 && value.phase !== "fencing" && value.phase !== "complete" && value.phase !== "held") ||
    (value.phase === "create-intent" && (value.container !== null || value.evidence !== null || value.fenceDeadline !== null || value.executionDeadline !== null || value.expiry !== null)) ||
    ((value.phase === "start-intent" || value.phase === "observing") && (value.container === null || value.evidence !== null || value.fenceDeadline !== null || value.executionDeadline === null || value.expiry !== null)) ||
    ((value.phase === "fencing" || value.phase === "complete") && (value.evidence === null || value.fenceDeadline === null)) ||
    ((value.phase === "complete") !== (value.barrier !== null)) || value.barrier !== null && (value.barrier === value.container || value.fenceTargets.includes(value.barrier)) ||
    (value.fenceDeadline !== null && value.fenceDeadline > value.deadline + 30_000) ||
    (value.evidence !== null && (value.evidence.observedAt < value.createdAt || value.evidence.id !== value.container ||
      (value.evidence.finishedAt !== null && (value.evidence.finishedAt < value.createdAt || value.evidence.finishedAt > value.evidence.observedAt)) ||
      (value.executionDeadline !== null && value.evidence.observedAt >= value.executionDeadline && (value.evidence.finishedAt === null || value.evidence.finishedAt > value.executionDeadline) && value.expiry !== "execution") ||
      ((value.evidence.kind === "succeeded" || value.evidence.kind === "failed") && (value.container === null || value.evidence.exitCode === null)) ||
      (value.evidence.kind === "succeeded" && value.evidence.exitCode !== 0) ||
      (value.evidence.probe !== null && (scope.value.purpose !== "probe" || value.evidence.kind !== "succeeded")) ||
      ((value.evidence.kind === "unknown" || value.evidence.kind === "not-started") && value.evidence.exitCode !== null)))) throw new Error("inconsistent one-shot execution record");
  const { cancelRequestedAt, ...record } = value;
  return Object.freeze({ ...record, scope: scope.value, ...(cancelRequestedAt === undefined ? {} : { cancelRequestedAt }) });
};
export type JobExecution = ReturnType<typeof parseJobExecution>;
type Ports = { readonly native: JobPort; readonly now: () => number; readonly read: (digest: string) => Promise<unknown>;
  /** The lifecycle owner must establish durable admission and unchanged ownership before every write. */
  readonly authorize: (record: JobExecution, effect: "create" | "start" | "fence") => Promise<boolean>;
  readonly materialize: (plan: JobPlan) => Promise<Readonly<Record<string, string>>>;
};

/** A job primitive, not an admission or rollout entrypoint. The owner supplies trusted ports. */
export const oneShotExecution = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "journal already has a one-shot owner");
  // eslint-disable-next-line functional/no-let -- serializes the owner's effects and persistence
  let pending = Promise.resolve();
  const serial = <T>(call: () => Promise<T>) => {
    const result = pending.then(call); pending = result.then(() => undefined, () => undefined); return result;
  };
  const write = async (value: JobExecution) => {
    const record = parseJobExecution(value); await journal.write(record); return record;
  };
  const load = async () => { const value = await journal.read(); return value === undefined ? undefined : parseJobExecution(value); };
  const clock = (minimum = 1) => {
    const value = ports.now(); if (!Number.isSafeInteger(value) || value < minimum) throw new Error("one-shot clock is unavailable"); return value;
  };
  const hold = (record: JobExecution) => write({ ...record, phase: "held" });
  return Object.freeze({
    prepare: (input: JobPlan) => serial(async () => {
      const parsed = parseJobPlan(input); if (!parsed.ok) throw new Error(parsed.error);
      const plan = parsed.value; const digest = jobPlanDigest(plan); const previous = await load();
      if (previous !== undefined) {
        if (previous.plan !== digest) throw new Error("one-shot journal belongs to a different plan"); return previous;
      }
      const now = clock(); if (now >= (plan.startDeadline ?? plan.deadline)) throw new Error("one-shot deadline already expired");
      return write({ version: 1, plan: digest, scope: plan.scope, createdAt: now, deadline: plan.deadline, phase: "create-intent", container: null, evidence: null, fenceDeadline: null, barrier: null, fenceTargets: [], executionDeadline: null, expiry: null });
    }),
    read: () => serial(load),
    cancel: () => serial(async () => {
      const record = await load(); if (record === undefined) throw new Error("one-shot intent is missing");
      if (record.cancelRequestedAt !== undefined || record.phase === "complete" || record.phase === "held" || record.phase === "fencing") return record;
      return write({ ...record, cancelRequestedAt: clock(record.createdAt) });
    }),
    tick: () => serial(async () => {
      const record = await load(); if (record === undefined) throw new Error("one-shot intent is missing");
      if (record.phase === "complete" || record.phase === "held") return record;
      const parsed = parseJobPlan(await ports.read(record.plan));
      if (!parsed.ok || jobPlanDigest(parsed.value) !== record.plan || JSON.stringify(parsed.value.scope) !== JSON.stringify(record.scope) || parsed.value.deadline !== record.deadline) throw new Error("one-shot immutable plan integrity failed");
      const plan = parsed.value; clock(record.createdAt);
      const observed = await ports.native.observe(plan);
      const now = clock(record.createdAt);
      if (observed.status === "foreign") return hold(record);
      if (record.phase === "fencing") {
        if (record.fenceDeadline === null || now >= record.fenceDeadline) return hold(record);
        if (observed.status === "unavailable") return record;
        if (observed.status === "owned" && observed.barrier) return observed.state === "created" && observed.id !== record.container
          ? write({ ...record, phase: "complete", barrier: observed.id }) : hold(record);
        // A duplicate pending Create may arrive after deleting the executed ID.
        // Preserve its original evidence, recording each additional ID before deletion.
        const extra = observed.status === "owned" && observed.id !== record.container && !record.fenceTargets.includes(observed.id);
        if (extra && record.fenceTargets.length >= 8) return hold(record);
        const current = extra ? await write({ ...record, fenceTargets: [...record.fenceTargets, observed.id] }) : record;
        if (!(await ports.authorize(current, "fence"))) return hold(current);
        await ports.native.fence(plan, observed.status === "owned" ? observed.id : current.container, record.fenceDeadline); return current;
      }
      const beginFence = async (kind: NonNullable<JobExecution["evidence"]>["kind"], container: string | null, exitCode: number | null, probe: NonNullable<JobExecution["evidence"]>["probe"] = null,
        finishedAt: number | null = null, expiry: JobExecution["expiry"] = null) => write({ ...record,
        container, phase: "fencing", evidence: { kind, id: container, exitCode, observedAt: clock(record.createdAt), probe, finishedAt }, expiry, fenceDeadline: Math.min(now + 30_000, record.deadline + 30_000),
      });
      if (record.cancelRequestedAt !== undefined) {
        if (observed.status === "owned" && (observed.barrier || record.container !== null && observed.id !== record.container)) return hold(record);
        if (observed.status === "owned" && record.phase !== "create-intent" && (observed.state === "succeeded" || observed.state === "failed")) {
          const executionDeadline = record.executionDeadline ?? record.deadline;
          return beginFence(observed.state, observed.id, observed.exitCode, observed.probe, observed.finishedAt,
            now >= executionDeadline && (observed.finishedAt === null || observed.finishedAt > executionDeadline) ? "execution" : null);
        }
        const unstarted = record.phase === "create-intent" && (observed.status === "absent" || observed.status === "owned" && observed.state === "created");
        const executionDeadline = record.executionDeadline ?? record.deadline;
        return beginFence(unstarted ? "not-started" : "unknown", observed.status === "owned" ? observed.id : record.container, null, null, null,
          now >= executionDeadline && record.executionDeadline !== null ? "execution" : null);
      }
      if (observed.status === "unavailable") {
        const limit = record.phase === "create-intent" ? plan.startDeadline ?? plan.deadline : record.executionDeadline ?? record.deadline;
        return now >= limit ? beginFence(record.phase === "create-intent" ? "not-started" : "unknown", record.container, null, null, null,
          record.phase === "create-intent" ? "scheduling" : "execution") : record;
      }
      if (observed.status === "owned") {
        if (observed.barrier || (record.container !== null && observed.id !== record.container)) return hold(record);
        if (record.phase === "create-intent" && observed.state !== "created") return hold(record);
        const executionDeadline = record.executionDeadline ?? record.deadline;
        if (observed.state === "succeeded" || observed.state === "failed") return beginFence(observed.state, observed.id, observed.exitCode, observed.probe, observed.finishedAt,
          now >= executionDeadline && (observed.finishedAt === null || observed.finishedAt > executionDeadline) ? "execution" : null);
        if (now >= (record.phase === "create-intent" ? plan.startDeadline ?? plan.deadline : executionDeadline)) return beginFence(record.phase === "create-intent" ? "not-started" : "unknown", observed.id, null, null, null,
          record.phase === "create-intent" ? "scheduling" : "execution");
        if (observed.state === "running") return record;
        if (observed.state !== "created" || record.phase !== "create-intent") return beginFence("unknown", observed.id, null);
        // This transition is durable BEFORE the only Start dispatch. Restart never replays it.
        const intent = await write({ ...record, phase: "start-intent", container: observed.id,
          executionDeadline: plan.executionTimeoutSeconds === undefined ? record.deadline : Math.min(record.deadline, clock(record.createdAt) + plan.executionTimeoutSeconds * 1000) });
        if (!(await ports.authorize(intent, "start"))) return hold(intent);
        const result = await ports.native.start(plan, observed.id, intent.executionDeadline ?? record.deadline);
        return result === "acknowledged" ? write({ ...intent, phase: "observing" }) : intent;
      }
      if (now >= (plan.startDeadline ?? plan.deadline) || record.phase !== "create-intent") return beginFence(record.phase === "create-intent" ? "not-started" : "unknown", record.container, null, null, null,
        record.phase === "create-intent" ? "scheduling" : null);
      if (!(await ports.authorize(record, "create"))) return hold(record);
      await ports.native.create(plan, await ports.materialize(plan)); return record;
    }),
  });
};
