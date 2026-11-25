import { parseMigrationResolutionQuery, parseMigrationResolutionAudit } from "../../contracts/migration-resolution.ts";
import { managedMigrationDescription } from "../../contracts/managed-application-plan.ts";
import { migrationSequenceDigest } from "../../contracts/migration-sequence.ts";
import type { ManagedDeploymentReadPort } from "../../contracts/managed-deployment-read.ts";
import { managedDeploymentEvidence } from "./managed-deployment-evidence.ts";

/** Owner projection only: no runtime, writer, effect permission or application probe is available to audit reads. */
export const managedMigrationAudit = async (input: unknown, sourceInput: unknown, queryInput: unknown, ports: Pick<ManagedDeploymentReadPort, "read">) => {
  const query = parseMigrationResolutionQuery(queryInput); if (!query.ok) throw new Error(query.error);
  const { state, source } = await managedDeploymentEvidence(input, sourceInput, ports); const operation = state.operation;
  if (state.owner.app !== query.value.app || operation.run !== query.value.run) throw new Error("managed migration audit scope disagrees");
  const sequence = operation.preparation?.sequence; if (sequence === null || sequence === undefined) return null;
  const description = managedMigrationDescription(source.candidate, source.run);
  if (!description.ok || sequence.plan !== migrationSequenceDigest(description.value) || sequence.plan !== operation.preparation?.sequencePlan || JSON.stringify(sequence.steps.map((step) => step.id)) !== JSON.stringify(description.value.steps.map((step) => step.definition.id))) throw new Error("managed migration audit description disagrees");
  const recorded = sequence.steps.find((step) => step.id === query.value.step)?.resolution; if (recorded === undefined) return null;
  const parsed = parseMigrationResolutionAudit(recorded); const receipt = operation.resolutionReceipts.find((item) => item.step === query.value.step);
  if (!parsed.ok || receipt === undefined || parsed.value.sequence !== sequence.plan || parsed.value.scope.app !== state.owner.app || parsed.value.scope.incarnation !== state.owner.incarnation || parsed.value.scope.run !== source.run || parsed.value.scope.step !== query.value.step ||
    receipt.resolution !== parsed.value.id || receipt.outcome !== parsed.value.outcome || receipt.recordedAt !== parsed.value.at) throw new Error("managed migration audit receipt disagrees");
  return parsed.value;
};
