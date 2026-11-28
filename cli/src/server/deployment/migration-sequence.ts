import { createHash } from "node:crypto";
import { z } from "zod";
import { migrationSequenceDigest, parseMigrationSequencePlan } from "../../contracts/migration-sequence.ts";
import type { MigrationSequencePlan } from "../../contracts/migration-sequence.ts";
import { jobPlanDigest, parseJobPlan } from "../../contracts/one-shot-job.ts";
import type { JobPlan, JobPort } from "../../contracts/one-shot-job.ts";
import { claimJournal } from "./journal-claim.ts";
import { oneShotExecution, parseJobExecution } from "./one-shot-execution.ts";
import type { JobExecution } from "./one-shot-execution.ts";
import type { OperationJournal } from "./operation.ts";
import { parseMigrationResolutionAudit } from "../../contracts/migration-resolution.ts";
import { parseMigrationCleanupRecord } from "../../contracts/migration-cleanup.ts";
import type { MigrationCleanupRecord } from "../../contracts/migration-cleanup.ts";
import { migrationResolutionId } from "./migration-resolution-audit.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const reason = z.enum(["deadline", "runtime", "unsafe-outcome", "probe-unknown", "not-applied", "attempts-exhausted", "cancelled"]);
const schema = z.object({ version: z.literal(1), plan: digest,
  scope: z.object({ app: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), incarnation: z.uuid(), run: z.uuid() }).strict().readonly(),
  createdAt: positive, deadline: positive, cancelRequestedAt: positive.optional(), completedAt: positive.nullable(), phase: z.enum(["running", "held", "succeeded"]), position: z.number().int().min(0).max(128), reason: reason.nullable(),
  steps: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
    phase: z.enum(["running", "applied", "held"]), reason: reason.nullable(), appliedAt: positive.nullable(), executionDeadline: positive.nullable(), resolution: z.unknown().optional(),
    attempts: z.array(z.object({ purpose: z.enum(["migration", "probe"]), attempt: positive.max(8), createdAt: positive,
      artifact: digest, execution: z.unknown().nullable(), cleanups: z.array(z.unknown()).max(8).readonly().optional() }).strict()).min(1).max(9).readonly(),
  }).strict()).max(128).readonly(),
}).strict().readonly();

export const migrationAttemptBarrier = (attempt: { readonly execution: JobExecution | null; readonly cleanups?: readonly MigrationCleanupRecord[] | undefined }) => {
  if (attempt.execution?.phase === "complete") return attempt.execution.barrier;
  const latest = attempt.cleanups?.at(-1)?.state;
  return latest?.phase === "complete" ? latest.barrier : null;
};

export const parseMigrationSequenceState = (input: unknown) => {
  const parsed = schema.safeParse(input); if (!parsed.success) throw new Error("invalid migration sequence state");
  const value = parsed.data;
  const steps = Object.freeze(value.steps.map((input) => {
    const { resolution: rawResolution, ...step } = input;
    const parsedResolution = rawResolution === undefined ? undefined : parseMigrationResolutionAudit(rawResolution);
    if (parsedResolution !== undefined && !parsedResolution.ok) throw new Error(parsedResolution.error);
    const resolution = parsedResolution?.value;
    if (resolution !== undefined && (resolution.sequence !== value.plan || resolution.scope.app !== value.scope.app || resolution.scope.incarnation !== value.scope.incarnation ||
      resolution.scope.run !== value.scope.run || resolution.scope.step !== step.id || resolution.at < value.createdAt || resolution.id !== migrationResolutionId(value.plan, resolution.scope) ||
      resolution.cancelRequestedAt !== undefined && (resolution.cancelRequestedAt !== value.cancelRequestedAt || resolution.cancelRequestedAt > resolution.at) ||
      step.phase === "running" || step.phase === "applied" && (resolution.outcome !== "applied" || resolution.at !== step.appliedAt || resolution.at >= value.deadline) ||
      step.phase === "held" && (resolution.outcome === "not-applied" ? step.reason !== "not-applied" : resolution.at < value.deadline || step.reason !== "deadline"))) throw new Error("migration resolution conflicts with sequence progress");
    const attempts = Object.freeze(step.attempts.map((attempt) => {
      const { cleanups: rawCleanups, ...original } = attempt;
      const execution = attempt.execution === null ? null : parseJobExecution(attempt.execution);
      const cleanups = rawCleanups === undefined ? undefined : Object.freeze(rawCleanups.map(parseMigrationCleanupRecord));
      if (cleanups !== undefined && (cleanups.length === 0 || execution?.phase !== "held" ||
        new Set(cleanups.map((item) => item.state.authority.action)).size !== cleanups.length || cleanups.some((item, index) =>
          item.state.authority.job !== attempt.artifact || item.state.authority.createdAt < execution.createdAt ||
          index > 0 && (cleanups[index - 1]?.state.phase !== "held" || item.state.authority.createdAt < (cleanups[index - 1]?.state.authority.createdAt ?? 0))))) throw new Error("invalid migration cleanup history");
      if (attempt.createdAt < value.createdAt || attempt.createdAt >= value.deadline || execution !== null && execution.createdAt < attempt.createdAt) throw new Error("invalid migration attempt time");
      if (execution !== null && (execution.plan !== attempt.artifact || execution.scope.app !== value.scope.app || execution.scope.incarnation !== value.scope.incarnation ||
        execution.scope.run !== value.scope.run || execution.scope.step !== step.id || execution.scope.purpose !== attempt.purpose || execution.scope.attempt !== attempt.attempt || execution.deadline > value.deadline ||
        (attempt.purpose === "migration" && execution.executionDeadline !== null && (step.executionDeadline === null || execution.executionDeadline > step.executionDeadline)))) throw new Error("migration job does not match its owner");
      return Object.freeze({ ...original, execution, ...(cleanups === undefined ? {} : { cleanups }) });
    }));
    const migrations = attempts.filter((attempt) => attempt.purpose === "migration"); const probes = attempts.filter((attempt) => attempt.purpose === "probe");
    const last = attempts.at(-1); const completed = last?.execution;
    if (migrations.length === 0 || migrations.some((attempt, index) => attempt.attempt !== index + 1) || probes.length > 1 || probes.some((attempt) => attempt.attempt !== 1) ||
      step.executionDeadline !== (migrations[0]?.execution?.executionDeadline ?? null) ||
      attempts.some((attempt, index) => index !== attempts.length - 1 && migrationAttemptBarrier(attempt) === null) ||
      (probes.length > 0 && attempts.at(-1)?.purpose !== "probe") ||
      (resolution !== undefined && attempts.some((attempt) => migrationAttemptBarrier(attempt) === null && !(value.cancelRequestedAt !== undefined && attempt.execution === null))) ||
      (step.phase === "applied" && resolution === undefined && (last === undefined || migrationAttemptBarrier(last) === null || completed?.expiry !== null || completed.evidence?.kind !== "succeeded" ||
        (last.purpose === "probe" && completed.evidence.probe !== "applied"))) ||
      (step.phase === "applied") !== (step.appliedAt !== null) ||
      (step.appliedAt !== null && (step.appliedAt < value.createdAt || step.appliedAt >= value.deadline)) ||
      ((step.phase === "held") !== (step.reason !== null))) throw new Error("inconsistent migration attempts or outcome");
    return Object.freeze({ ...step, attempts, ...(resolution === undefined ? {} : { resolution }) });
  }));
  const cleanupActions = steps.flatMap((step) => Object.freeze(step.attempts.flatMap((attempt) => Object.freeze(attempt.cleanups?.map((item) => item.state.authority.action) ?? []))));
  if (new Set(cleanupActions).size !== cleanupActions.length) throw new Error("migration cleanup action identity is reused");
  const completedAt = value.completedAt;
  if (value.createdAt >= value.deadline || new Set(steps.map((step) => step.id)).size !== steps.length ||
    (value.phase === "succeeded") !== (completedAt !== null) ||
    (completedAt !== null && (completedAt < value.createdAt || completedAt >= value.deadline || steps.some((step) => (step.appliedAt ?? 0) > completedAt))) ||
    steps.some((step, index) => index < value.position ? step.phase !== "applied" : index !== value.position || step.phase === "applied") ||
    (value.position !== steps.length && value.position !== steps.length - 1) ||
    (value.phase === "succeeded" && value.position !== steps.length) ||
    (value.phase === "held") !== (value.reason !== null) ||
    (value.phase === "held" && steps.length > value.position && steps[value.position]?.phase !== "held")) throw new Error("inconsistent migration sequence progress");
  const { cancelRequestedAt, ...record } = value;
  if (cancelRequestedAt !== undefined && cancelRequestedAt < value.createdAt) throw new Error("invalid migration cancellation time");
  return Object.freeze({ ...record, steps, ...(cancelRequestedAt === undefined ? {} : { cancelRequestedAt }) });
};
export type MigrationSequenceState = ReturnType<typeof parseMigrationSequenceState>;
export const migrationDescriptionForState = (state: MigrationSequenceState, input: unknown) => {
  const parsed = parseMigrationSequencePlan(input);
  if (!parsed.ok || migrationSequenceDigest(parsed.value) !== state.plan || JSON.stringify(parsed.value.scope) !== JSON.stringify(state.scope) || state.position > parsed.value.steps.length ||
    state.steps.some((step, index) => step.id !== parsed.value.steps[index]?.definition.id) ||
    state.phase === "running" && state.position === parsed.value.steps.length || state.phase === "succeeded" && state.position !== parsed.value.steps.length) throw new Error("migration description or scope changed");
  return parsed.value;
};
type Ports = { readonly native: JobPort; readonly now: () => number; readonly read: (digest: string) => Promise<string>; readonly retain: (bytes: string) => Promise<string>;
  readonly authorize: (state: MigrationSequenceState, plan: MigrationSequencePlan, job: JobExecution, effect: "create" | "start" | "fence") => Promise<boolean>;
  readonly materialize: (job: JobPlan, plan: MigrationSequencePlan) => Promise<Readonly<Record<string, string>>>;
};
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

export const migrationJobDescription = (state: MigrationSequenceState, plan: MigrationSequencePlan, position: number, purpose: "migration" | "probe", attempt: number, createdAt: number) => {
  const source = plan.steps[position]; if (source === undefined) throw new Error("migration source step is missing");
  const recovery = source.definition.recovery;
  if (purpose === "probe" && recovery.kind !== "status-probe") throw new Error("migration has no status probe");
  const seconds = purpose === "probe" && recovery.kind === "status-probe" ? recovery.timeout_seconds : source.definition.timeout_seconds;
  const previous = state.steps[position]?.executionDeadline;
  if (purpose === "migration" && attempt > 1 && (previous === undefined || previous === null)) throw new Error("migration retry has no original execution deadline");
  const ceiling = purpose === "migration" && attempt > 1 && previous !== undefined && previous !== null ? Math.min(previous, state.deadline) : state.deadline;
  const startDeadline = Math.min(ceiling, createdAt + plan.policy.schedulingSeconds * 1000);
  const parsed = parseJobPlan({ ...source.template, scope: { ...state.scope, step: source.definition.id, purpose, attempt },
    command: purpose === "probe" && recovery.kind === "status-probe" ? recovery.command : source.definition.command,
    startDeadline, executionTimeoutSeconds: seconds, deadline: Math.min(ceiling, startDeadline + seconds * 1000) });
  if (!parsed.ok) throw new Error(parsed.error); return parsed.value;
};

/** Serialized phase owner. Its parent must supply lifecycle fencing and durable resource admission. */
export const migrationSequence = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "journal already has a migration sequence owner");
  // eslint-disable-next-line functional/no-let -- serializes the owning phase and its private job handles
  let pending = Promise.resolve();
  const children = new Map<string, ReturnType<typeof oneShotExecution>>();
  const serial = <T>(call: () => Promise<T>) => { const result = pending.then(call); pending = result.then(() => undefined, () => undefined); return result; };
  const load = async () => { const raw = await journal.read(); return raw === undefined ? undefined : parseMigrationSequenceState(raw); };
  const required = async () => { const value = await load(); if (value === undefined) throw new Error("migration sequence intent is missing"); return value; };
  const write = async (input: MigrationSequenceState) => { const value = parseMigrationSequenceState(input); await journal.write(value); return value; };
  const time = (minimum = 1) => { const value = ports.now(); if (!Number.isSafeInteger(value) || value < minimum) throw new Error("migration sequence clock is unavailable"); return value; };
  const read = async (digest: string) => { const bytes = await ports.read(digest); if (hash(bytes) !== digest) throw new Error("migration artifact integrity failed"); const value: unknown = JSON.parse(bytes); return value; };
  const description = async (state: MigrationSequenceState) => {
    return migrationDescriptionForState(state, await read(state.plan));
  };
  const hold = (state: MigrationSequenceState, why: z.infer<typeof reason>) => write({ ...state, phase: "held", reason: why,
    steps: state.steps.map((step, index) => index === state.position ? { ...step, phase: "held", reason: why } : step) });
  const retainJob = async (plan: JobPlan) => {
    const parsed = parseJobPlan(plan); if (!parsed.ok) throw new Error(parsed.error);
    const artifact = await ports.retain(JSON.stringify(parsed.value)); if (artifact !== jobPlanDigest(parsed.value)) throw new Error("migration job retention failed"); return artifact;
  };
  const child = (state: MigrationSequenceState, plan: MigrationSequencePlan, position: number, index: number) => {
    const attempt = state.steps[position]?.attempts[index]; if (attempt === undefined) throw new Error("migration attempt is missing");
    const key = `${String(position)}:${String(index)}`; const existing = children.get(key); if (existing !== undefined) return existing;
    // Private view into this same exclusively owned journal, never a second writer or exposed handle.
    const view = {
      read: async () => (await required()).steps[position]?.attempts[index]?.execution ?? undefined,
      write: async (input: unknown) => {
        const after = parseJobExecution(input); const current = await required(); const step = current.steps[position]; const before = step?.attempts[index];
        if (step === undefined || before === undefined || current.phase !== "running" || current.position !== position || index !== step.attempts.length - 1 ||
          before.artifact !== after.plan || (before.execution !== null && (before.execution.phase === "complete" || before.execution.phase === "held")) ||
          (before.execution?.executionDeadline !== undefined && before.execution.executionDeadline !== null && before.execution.executionDeadline !== after.executionDeadline)) throw new Error("migration job lost ownership or changed its deadline");
        const executionDeadline = before.purpose === "migration" && step.executionDeadline === null ? after.executionDeadline : step.executionDeadline;
        await write({ ...current, steps: current.steps.map((item, at) => at !== position ? item : { ...item, executionDeadline,
          attempts: item.attempts.map((entry, number) => number === index ? { ...entry, execution: after } : entry) }) });
      },
    };
    const owner = oneShotExecution(view, { native: ports.native, now: ports.now, read,
      authorize: async (job, effect) => {
        const current = await required(); const selected = current.steps[position]; const recorded = selected?.attempts[index];
        if (current.phase !== "running" || current.position !== position || index !== (selected?.attempts.length ?? 0) - 1 ||
          recorded?.artifact !== job.plan || JSON.stringify(recorded.execution) !== JSON.stringify(job)) return false;
        if (current.cancelRequestedAt !== undefined && job.scope.purpose === "migration" && effect !== "fence") return false;
        return ports.authorize(current, plan, job, effect);
      }, materialize: (job) => ports.materialize(job, plan) });
    // eslint-disable-next-line functional/immutable-data -- one private child owner per persisted identity
    children.set(key, owner); return owner;
  };
  const schedule = async (state: MigrationSequenceState, plan: MigrationSequencePlan, purpose: "migration" | "probe") => {
    const source = plan.steps[state.position]; if (source === undefined) throw new Error("migration source step is missing");
    const now = time(state.createdAt); const current = state.steps[state.position];
    if (purpose === "migration" && state.cancelRequestedAt !== undefined) return hold(state, current === undefined ? "cancelled" : "unsafe-outcome");
    const prior = current?.attempts.filter((item) => item.purpose === purpose).length ?? 0;
    const ceiling = purpose === "migration" && prior > 0 && current?.executionDeadline !== null && current?.executionDeadline !== undefined ? Math.min(current.executionDeadline, state.deadline) : state.deadline;
    if (now >= ceiling) return hold(state, "deadline");
    if (prior >= plan.policy.maximumAttempts) return hold(state, "attempts-exhausted");
    const artifact = await retainJob(migrationJobDescription(state, plan, state.position, purpose, prior + 1, now));
    const attempt = Object.freeze({ purpose, attempt: prior + 1, createdAt: now, artifact, execution: null });
    return write({ ...state, steps: current === undefined ? [...state.steps, { id: source.definition.id, phase: "running", reason: null, appliedAt: null, executionDeadline: null, attempts: [attempt] }]
      : state.steps.map((step, index) => index === state.position ? Object.freeze({ ...step, attempts: Object.freeze([...step.attempts, attempt]) }) : step) });
  };
  return Object.freeze({
    prepare: (input: MigrationSequencePlan, deadline: number) => serial(async () => {
      const parsed = parseMigrationSequencePlan(input); if (!parsed.ok) throw new Error(parsed.error);
      const plan = parsed.value; const digest = migrationSequenceDigest(plan); const previous = await load();
      if (previous !== undefined) { if (previous.plan !== digest || previous.deadline !== deadline) throw new Error("migration sequence intent conflicts"); return previous; }
      const now = time(); if (!Number.isSafeInteger(deadline) || deadline <= now) throw new Error("migration sequence deadline expired");
      if (await ports.retain(JSON.stringify(plan)) !== digest) throw new Error("migration sequence retention failed");
      return write({ version: 1, plan: digest, scope: plan.scope, createdAt: now, deadline, completedAt: null, phase: "running", position: 0, reason: null, steps: [] });
    }),
    read: () => serial(load),
    cancel: () => serial(async () => {
      const state = await required(); if (state.cancelRequestedAt !== undefined || state.phase === "succeeded") return state;
      return write({ ...state, cancelRequestedAt: time(state.createdAt) });
    }),
    tick: () => serial(async () => {
      const state = await required(); if (state.phase !== "running") return state;
      const plan = await description(state); const now = time(state.createdAt); const step = state.steps[state.position];
      if (step === undefined) return now >= state.deadline ? hold(state, "deadline") : schedule(state, plan, "migration");
      const index = step.attempts.length - 1; const attempt = step.attempts[index]; if (attempt === undefined) throw new Error("migration attempt is missing");
      const raw = parseJobPlan(await read(attempt.artifact));
      if (!raw.ok || jobPlanDigest(raw.value) !== attempt.artifact || jobPlanDigest(migrationJobDescription(state, plan, state.position, attempt.purpose, attempt.attempt, attempt.createdAt)) !== attempt.artifact) throw new Error("migration job description changed");
      const owner = child(state, plan, state.position, index);
      if (attempt.execution === null) {
        if (state.cancelRequestedAt !== undefined && attempt.purpose === "migration") return hold(state, "cancelled");
        if (now >= (raw.value.startDeadline ?? raw.value.deadline)) return hold(state, "deadline");
        await owner.prepare(raw.value); return required();
      }
      if (migrationAttemptBarrier(attempt) === null) {
        if (attempt.execution.phase === "held") return hold(state, "runtime");
        if (state.cancelRequestedAt !== undefined && attempt.purpose === "migration") await owner.cancel();
        await owner.tick(); return required();
      }
      const outcome = attempt.execution.evidence;
      if (outcome === null || time(state.createdAt) >= state.deadline) return hold(state, "deadline");
      const source = plan.steps[state.position]; if (source === undefined) throw new Error("migration source step is missing");
      if (attempt.execution.expiry !== null) return attempt.purpose === "migration" && attempt.execution.expiry === "execution" && source.definition.recovery.kind === "status-probe"
        ? schedule(state, plan, "probe") : hold(state, "deadline");
      if (attempt.purpose === "migration" && outcome.kind === "succeeded" || attempt.purpose === "probe" && outcome.kind === "succeeded" && outcome.probe === "applied") {
        const appliedAt = time(state.createdAt); if (appliedAt >= state.deadline) return hold(state, "deadline");
        const position = state.position + 1; const done = position === plan.steps.length;
        return write({ ...state, position, phase: done ? "succeeded" : "running", completedAt: done ? appliedAt : null,
          steps: state.steps.map((item, index) => index === state.position ? { ...item, phase: "applied", appliedAt } : item) });
      }
      if (attempt.purpose === "probe") return hold(state, outcome.probe === "not-applied" ? "not-applied" : "probe-unknown");
      return source.definition.recovery.kind === "replay-safe" ? schedule(state, plan, "migration") : schedule(state, plan, "probe");
    }),
  });
};
