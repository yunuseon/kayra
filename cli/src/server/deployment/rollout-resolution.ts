import { createHash } from "node:crypto";
import { parseRolloutPlan, rolloutMigrationDescription, rolloutWorkloadDigest } from "../../contracts/rollout-plan.ts";
import { migrationSequenceDigest } from "../../contracts/migration-sequence.ts";
import { parseMigrationResolutionReceipt } from "../../contracts/migration-resolution.ts";
import type { MigrationResolutionActor, MigrationResolutionRequest } from "../../contracts/migration-resolution.ts";
import { parseRolloutRequest } from "./rollout-request.ts";
import { resolveMigrationSequence } from "./migration-resolution.ts";

type Ports = Parameters<typeof resolveMigrationSequence>[4];

/** The app lifecycle writer authenticates the operator and persists this transition atomically. */
export const resolveRolloutMigration = async (input: ReturnType<typeof parseRolloutRequest>, request: MigrationResolutionRequest, actor: MigrationResolutionActor, previous: string | null, ports: Ports) => {
  const operation = parseRolloutRequest(input); const preparation = operation.preparation; const sequence = preparation.sequence;
  if (sequence === null) throw new Error("rollout has no migration evidence to resolve");
  const bytes = await ports.read(preparation.plan); const raw: unknown = JSON.parse(bytes); const parsed = parseRolloutPlan(raw);
  if (!parsed.ok || createHash("sha256").update(bytes).digest("hex") !== preparation.plan || rolloutWorkloadDigest(parsed.value) !== preparation.workload ||
    parsed.value.workload.app !== preparation.app || parsed.value.workload.registration.incarnation !== preparation.incarnation || parsed.value.workload.commit !== operation.commit) throw new Error("migration resolution rollout plan integrity failed");
  const source = rolloutMigrationDescription(parsed.value, preparation.run);
  if (!source.ok || migrationSequenceDigest(source.value) !== preparation.source || sequence.plan !== preparation.source) throw new Error("migration resolution source changed");
  const recorded = sequence.steps.find((step) => step.id === request.step)?.resolution;
  if (recorded === undefined && (operation.completion !== undefined || preparation.phase !== "held")) throw new Error("rollout preparation is not held for resolution");
  const resolved = await resolveMigrationSequence(sequence, source.value, request, actor, ports);
  const next = recorded !== undefined ? operation : parseRolloutRequest({ ...operation,
    preparation: { ...preparation, sequence: resolved.state, phase: resolved.disposition === "continue" ? "migrating" : "held", reason: resolved.disposition === "continue" ? null : resolved.state.reason === "deadline" ? "deadline" : "migration" },
    ...(resolved.disposition === "continue" ? {} : { completion: { kind: "migration-resolved", outcome: "failed", reason: resolved.audit.outcome === "not-applied" ? "migration" : "deadline",
      at: resolved.audit.at, previous, resolution: resolved.audit.id, step: request.step } }),
  });
  const receipt = parseMigrationResolutionReceipt({ version: 1, app: resolved.audit.scope.app, run: resolved.audit.scope.run, step: resolved.audit.scope.step,
    resolution: resolved.audit.id, outcome: resolved.audit.outcome, recordedAt: resolved.audit.at, disposition: resolved.disposition });
  if (!receipt.ok) throw new Error(receipt.error);
  return Object.freeze({ operation: next, receipt: receipt.value, changed: recorded === undefined, audit: resolved.audit });
};
