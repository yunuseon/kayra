import { createHash } from "node:crypto";
import { parseMigrationResolutionActor, parseMigrationResolutionRequest } from "../../contracts/migration-resolution.ts";
import type { MigrationResolutionActor, MigrationResolutionAudit, MigrationResolutionRequest } from "../../contracts/migration-resolution.ts";
import type { MigrationSequencePlan } from "../../contracts/migration-sequence.ts";
import { jobPlanDigest, parseJobPlan } from "../../contracts/one-shot-job.ts";
import type { JobPort } from "../../contracts/one-shot-job.ts";
import { migrationDescriptionForState, migrationJobDescription, parseMigrationSequenceState } from "./migration-sequence.ts";
import type { MigrationSequenceState } from "./migration-sequence.ts";
import { migrationResolutionAudit } from "./migration-resolution-audit.ts";

type Ports = { readonly read: (digest: string) => Promise<string>; readonly now: () => number; readonly native: Pick<JobPort, "observe"> };
const sameStatement = (audit: MigrationResolutionAudit, input: MigrationResolutionRequest, actor: MigrationResolutionActor) => audit.scope.app === input.app && audit.scope.run === input.run &&
  audit.scope.step === input.step && audit.outcome === input.outcome && audit.reason === input.reason && JSON.stringify(audit.actor) === JSON.stringify(actor);

/** Computes one atomic parent-journal transition. The lifecycle owner authenticates the caller and persists it. */
export const resolveMigrationSequence = async (input: MigrationSequenceState, source: MigrationSequencePlan, statement: MigrationResolutionRequest, actor: MigrationResolutionActor, ports: Ports) => {
  const state = parseMigrationSequenceState(input); const plan = migrationDescriptionForState(state, source); const request = parseMigrationResolutionRequest(statement); const operator = parseMigrationResolutionActor(actor);
  if (!request.ok || !operator.ok || request.value.app !== state.scope.app || request.value.run !== state.scope.run) throw new Error("migration resolution scope or description changed");
  const existing = state.steps.find((step) => step.id === request.value.step)?.resolution;
  if (existing !== undefined) {
    if (!sameStatement(existing, request.value, operator.value)) throw new Error("migration outcome was already resolved differently");
    return Object.freeze({ state, audit: existing, disposition: existing.outcome === "applied" && existing.at < state.deadline ? "continue" as const : "failed" as const });
  }
  const step = state.steps[state.position];
  if (state.phase !== "held" || step?.phase !== "held" || step.id !== request.value.step ||
    step.attempts.some((attempt) => attempt.execution?.phase !== "complete")) throw new Error("migration resolution requires a held step with every attempt fenced");
  for (const attempt of step.attempts) {
    const bytes = await ports.read(attempt.artifact); const value: unknown = JSON.parse(bytes); const parsed = parseJobPlan(value);
    if (!parsed.ok || createHash("sha256").update(bytes).digest("hex") !== attempt.artifact || jobPlanDigest(parsed.value) !== attempt.artifact ||
      jobPlanDigest(migrationJobDescription(state, plan, state.position, attempt.purpose, attempt.attempt, attempt.createdAt)) !== attempt.artifact) throw new Error("migration resolution job description changed");
    const observed = await ports.native.observe(parsed.value);
    if (observed.status !== "owned" || !observed.barrier || observed.state !== "created" || observed.id !== attempt.execution?.barrier || observed.plan !== attempt.artifact) throw new Error("migration resolution has no current owned fence proof");
  }
  const now = ports.now();
  if (!Number.isSafeInteger(now) || now < state.createdAt) throw new Error("migration resolution clock is unavailable");
  const audit = migrationResolutionAudit(state.plan, state.scope.incarnation, request.value, operator.value, now);
  if (audit.outcome !== "applied" || now >= state.deadline) {
    const reason = audit.outcome === "not-applied" ? "not-applied" as const : "deadline" as const;
    return Object.freeze({ state: parseMigrationSequenceState({ ...state, phase: "held", reason,
      steps: state.steps.map((item, index) => index === state.position ? Object.freeze({ ...item, resolution: audit, phase: "held", reason }) : item) }), audit, disposition: "failed" as const });
  }
  const position = state.position + 1; const done = position === plan.steps.length;
  const next = parseMigrationSequenceState({ ...state, position, phase: done ? "succeeded" : "running", reason: null, completedAt: done ? now : null,
    steps: state.steps.map((item, index) => index === state.position ? Object.freeze({ ...item, resolution: audit, phase: "applied", appliedAt: now, reason: null }) : item) });
  return Object.freeze({ state: next, audit, disposition: "continue" as const });
};
