import { createHash } from "node:crypto";
import { z } from "zod";
import { parseRolloutPlan, rolloutMigrationDescription, rolloutOperationSeconds, rolloutPlanDigest, rolloutWorkloadDigest } from "../../contracts/rollout-plan.ts";
import type { RolloutPlan } from "../../contracts/rollout-plan.ts";
import { migrationSequenceDigest } from "../../contracts/migration-sequence.ts";
import type { JobExecution } from "./one-shot-execution.ts";
import type { OperationJournal } from "./operation.ts";
import { claimJournal } from "./journal-claim.ts";
import { migrationSequence, parseMigrationSequenceState } from "./migration-sequence.ts";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({ version: z.literal(1), run: z.uuid(), app: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), incarnation: z.uuid(),
  plan: digest, workload: digest, source: digest.nullable(), createdAt: positive, deadline: positive, migrationDeadline: positive,
  phase: z.enum(["prepared", "migrating", "ready", "held"]), reason: z.enum(["deadline", "migration"]).nullable(),
  httpDeadline: positive.nullable(), sequence: z.unknown().nullable(),
}).strict().readonly();

/** Private phase state; readiness here permits HTTP preparation, never release promotion. */
export const parseRolloutPreparation = (input: unknown) => {
  const parsed = schema.safeParse(input); if (!parsed.success) throw new Error("invalid rollout preparation");
  const state = parsed.data; const sequence = state.sequence === null ? null : parseMigrationSequenceState(state.sequence);
  if (state.createdAt >= state.migrationDeadline || state.migrationDeadline !== state.deadline - 180_000 ||
    (state.phase === "held") !== (state.reason !== null) ||
    (state.phase === "ready") !== (state.httpDeadline !== null) ||
    (state.httpDeadline !== null && (state.httpDeadline <= state.createdAt || state.httpDeadline > state.deadline - 90_000)) ||
    (sequence !== null && (state.source !== sequence.plan || sequence.scope.app !== state.app || sequence.scope.incarnation !== state.incarnation || sequence.scope.run !== state.run ||
      sequence.createdAt < state.createdAt || sequence.deadline !== state.migrationDeadline)) ||
    (state.phase === "prepared" && sequence !== null) ||
    (state.phase === "migrating" && (state.source === null || sequence === null)) ||
    (state.phase === "ready" && state.source !== null && sequence?.phase !== "succeeded") ||
    (state.phase === "ready" && sequence?.completedAt !== null && sequence?.completedAt !== undefined && sequence.completedAt >= (state.httpDeadline ?? 0))) throw new Error("inconsistent rollout preparation");
  return Object.freeze({ ...state, sequence });
};
export type RolloutPreparation = ReturnType<typeof parseRolloutPreparation>;
type SequencePorts = Parameters<typeof migrationSequence>[1];
type Ports = Pick<SequencePorts, "native" | "now" | "read" | "retain"> & {
  /** The lifecycle owner checks its current fence and durable host reservation for each effect. */
  readonly authorize: (state: RolloutPreparation, plan: RolloutPlan, job: JobExecution, effect: "create" | "start" | "fence") => Promise<boolean>;
  readonly materialize: (job: Parameters<SequencePorts["materialize"]>[0], plan: RolloutPlan) => ReturnType<SequencePorts["materialize"]>;
};
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

/** The lifecycle writer persists this with the accepted ticket, before admission or runtime work. */
export const initialRolloutPreparation = (input: RolloutPlan, run: string, now: number) => {
  const checked = parseRolloutPlan(input); if (!checked.ok || !z.uuid().safeParse(run).success || !Number.isSafeInteger(now) || now <= 0) throw new Error("invalid rollout preparation request");
  const plan = checked.value; const source = plan.rollout.migrations.length === 0 ? null : rolloutMigrationDescription(plan, run);
  if (source !== null && !source.ok) throw new Error(source.error);
  const deadline = now + rolloutOperationSeconds(plan) * 1000;
  return parseRolloutPreparation({ version: 1, app: plan.workload.app, incarnation: plan.workload.registration.incarnation, run, plan: rolloutPlanDigest(plan), workload: rolloutWorkloadDigest(plan),
    source: source === null ? null : migrationSequenceDigest(source.value), createdAt: now, deadline, migrationDeadline: deadline - 180_000,
    phase: "prepared", reason: null, httpDeadline: null, sequence: null });
};

/** One private journal view under the application's lifecycle writer and admission lease. */
export const rolloutPreparation = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "journal already has a rollout preparation owner");
  // eslint-disable-next-line functional/no-let -- serializes the parent and its private migration phase
  let pending = Promise.resolve();
  const serial = <T>(call: () => Promise<T>) => { const result = pending.then(call); pending = result.then(() => undefined, () => undefined); return result; };
  const load = async () => { const raw = await journal.read(); return raw === undefined ? undefined : parseRolloutPreparation(raw); };
  const required = async () => { const state = await load(); if (state === undefined) throw new Error("rollout preparation intent is missing"); return state; };
  const write = async (input: RolloutPreparation) => { const state = parseRolloutPreparation(input); await journal.write(state); return state; };
  const time = (minimum = 1) => { const now = ports.now(); if (!Number.isSafeInteger(now) || now < minimum) throw new Error("rollout preparation clock is unavailable"); return now; };
  const description = async (state: RolloutPreparation) => {
    const bytes = await ports.read(state.plan); const input: unknown = JSON.parse(bytes); const checked = parseRolloutPlan(input);
    if (hash(bytes) !== state.plan || !checked.ok || rolloutPlanDigest(checked.value) !== state.plan || rolloutWorkloadDigest(checked.value) !== state.workload ||
      checked.value.workload.app !== state.app || checked.value.workload.registration.incarnation !== state.incarnation ||
      state.deadline !== state.createdAt + rolloutOperationSeconds(checked.value) * 1000) throw new Error("rollout preparation plan integrity failed");
    const sequence = checked.value.rollout.migrations.length === 0 ? null : rolloutMigrationDescription(checked.value, state.run);
    if (sequence !== null && !sequence.ok) throw new Error(sequence.error);
    if ((sequence === null ? null : migrationSequenceDigest(sequence.value)) !== state.source) throw new Error("rollout migration source changed");
    if (sequence !== null) {
      const bytes = await ports.read(state.source ?? "");
      if (hash(bytes) !== state.source || bytes !== JSON.stringify(sequence.value) || state.sequence !== null &&
        (state.sequence.steps.some((step, index) => step.id !== sequence.value.steps[index]?.definition.id) ||
          state.sequence.phase === "succeeded" && state.sequence.position !== sequence.value.steps.length)) throw new Error("rollout migration evidence changed");
    }
    const workload = await ports.read(state.workload);
    if (hash(workload) !== state.workload || workload !== JSON.stringify(checked.value.workload)) throw new Error("rollout workload projection changed");
    return checked.value;
  };
  // The child has no filesystem handle or independent process lock.
  const view = {
    read: async () => (await required()).sequence ?? undefined,
    write: async (input: unknown) => {
      const current = await required(); const sequence = parseMigrationSequenceState(input);
      if (current.phase !== "prepared" && current.phase !== "migrating") throw new Error("migration phase lost rollout ownership");
      await write({ ...current, phase: "migrating", sequence });
    },
  };
  const child = migrationSequence(view, { ...ports,
    authorize: async (_sequence, _source, job, effect) => {
      const state = await required(); if (state.phase !== "migrating") return false;
      const plan = await description(state); return ports.authorize(state, plan, job, effect);
    },
    materialize: async (job) => { const state = await required(); return ports.materialize(job, await description(state)); },
  });
  const hold = (state: RolloutPreparation, reason: "deadline" | "migration") => write({ ...state, phase: "held", reason, httpDeadline: null });
  return Object.freeze({
    prepare: (input: RolloutPlan, run: string) => serial(async () => {
      const parsed = parseRolloutPlan(input); if (!parsed.ok || !z.uuid().safeParse(run).success) throw new Error("invalid rollout preparation request");
      const plan = parsed.value; const digest = rolloutPlanDigest(plan); const previous = await load();
      if (previous !== undefined) { if (previous.plan !== digest || previous.run !== run) throw new Error("rollout preparation intent conflicts"); await description(previous); return previous; }
      const intent = initialRolloutPreparation(plan, run, time());
      const source = plan.rollout.migrations.length === 0 ? null : rolloutMigrationDescription(plan, run);
      if (source !== null && !source.ok) throw new Error(source.error);
      if (await ports.retain(JSON.stringify(plan)) !== digest || await ports.retain(JSON.stringify(plan.workload)) !== rolloutWorkloadDigest(plan)) throw new Error("rollout preparation retention failed");
      const sourceDigest = source === null ? null : migrationSequenceDigest(source.value);
      if (source !== null && await ports.retain(JSON.stringify(source.value)) !== sourceDigest) throw new Error("rollout migration retention failed");
      return write(intent);
    }),
    read: () => serial(load),
    tick: () => serial(async () => {
      const state = await required(); const plan = await description(state);
      if (state.phase === "held" || state.phase === "ready") return state;
      if (state.source !== null) {
        const source = rolloutMigrationDescription(plan, state.run); if (!source.ok) throw new Error(source.error);
        if (state.sequence === null) {
          if (time(state.createdAt) >= state.migrationDeadline) return hold(state, "deadline");
          await child.prepare(source.value, state.migrationDeadline); return required();
        }
        if (state.sequence.phase === "held") return hold(state, "migration");
        if (state.sequence.phase !== "succeeded") { await child.tick(); return required(); }
      }
      const now = time(state.createdAt);
      if (now >= state.migrationDeadline) return hold(state, "deadline");
      return write({ ...state, phase: "ready", httpDeadline: now + 90_000 });
    }),
  });
};
