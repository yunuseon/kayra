import { managedApplicationDigest, managedMigrationDescription } from "../../contracts/managed-application-plan.ts";
import { migrationSequenceDigest } from "../../contracts/migration-sequence.ts";
import { parseMigrationResolutionReceipt } from "../../contracts/migration-resolution.ts";
import type { MigrationResolutionActor, MigrationResolutionRequest } from "../../contracts/migration-resolution.ts";
import { parseManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import { parseManagedGroupPreparation } from "./managed-group-preparation.ts";
import type { ManagedGroupPreparation } from "./managed-group-preparation.ts";
import { resolveMigrationSequence } from "./migration-resolution.ts";

/** Computes one audited parent transition, never mutates a job or rewrites its original execution evidence. The root authenticates the actor and synchronizes this result. */
export const resolveManagedPreparationMigration = async (input: ManagedGroupPreparation, retained: ManagedLifecycleSource, request: MigrationResolutionRequest, actor: MigrationResolutionActor, ports: Parameters<typeof resolveMigrationSequence>[4]) => {
  const preparation = parseManagedGroupPreparation(input); const source = parseManagedLifecycleSource(retained); const owner = source.candidate.infrastructure.ownership;
  if (preparation.sequence === null || preparation.plan !== managedApplicationDigest(source.candidate) || preparation.run !== source.run || preparation.action !== source.action || preparation.app !== owner.app || preparation.incarnation !== owner.incarnation || preparation.dataOwner !== owner.dataOwner) throw new Error("managed migration resolution source disagrees");
  const description = managedMigrationDescription(source.candidate, source.run);
  if (!description.ok || migrationSequenceDigest(description.value) !== preparation.sequencePlan || preparation.sequence.plan !== preparation.sequencePlan) throw new Error("managed migration resolution description changed");
  const recorded = preparation.sequence.steps.find((step) => step.id === request.step)?.resolution;
  if (recorded === undefined && (preparation.phase !== "held" || preparation.reason !== "migration")) throw new Error("managed preparation is not held for migration resolution");
  const resolved = await resolveMigrationSequence(preparation.sequence, description.value, request, actor, ports);
  const next = recorded === undefined ? parseManagedGroupPreparation({ ...preparation, sequence: resolved.state, phase: resolved.disposition === "continue" ? "migrating" : "held", reason: resolved.disposition === "continue" ? null : resolved.state.reason === "deadline" ? "deadline" : "migration" }) : preparation;
  const receipt = parseMigrationResolutionReceipt({ version: 1, app: resolved.audit.scope.app, run: resolved.audit.scope.run, step: resolved.audit.scope.step, resolution: resolved.audit.id, outcome: resolved.audit.outcome, recordedAt: resolved.audit.at, disposition: resolved.disposition });
  if (!receipt.ok) throw new Error(receipt.error);
  return Object.freeze({ preparation: next, receipt: receipt.value, audit: resolved.audit, changed: recorded === undefined });
};
