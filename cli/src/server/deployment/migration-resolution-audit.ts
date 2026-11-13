import { createHash } from "node:crypto";
import { parseMigrationResolutionActor, parseMigrationResolutionAudit, parseMigrationResolutionRequest } from "../../contracts/migration-resolution.ts";
import type { MigrationResolutionActor, MigrationResolutionAudit, MigrationResolutionRequest } from "../../contracts/migration-resolution.ts";

export const migrationResolutionId = (sequence: string, scope: MigrationResolutionAudit["scope"]) => createHash("sha256").update(JSON.stringify({
  version: 1, kind: "migration-resolution", sequence, app: scope.app, incarnation: scope.incarnation, run: scope.run, step: scope.step,
})).digest("hex");

/** The caller authenticates the actor and supplies the retained sequence identity. */
export const migrationResolutionAudit = (sequence: string, incarnation: string, input: MigrationResolutionRequest, actor: MigrationResolutionActor, at: number) => {
  const request = parseMigrationResolutionRequest(input); const operator = parseMigrationResolutionActor(actor);
  if (!request.ok || !operator.ok) throw new Error("invalid migration resolution or operator identity");
  const scope = Object.freeze({ app: request.value.app, incarnation, run: request.value.run, step: request.value.step });
  const parsed = parseMigrationResolutionAudit({ version: 1, sequence, scope, id: migrationResolutionId(sequence, scope), actor: operator.value,
    outcome: request.value.outcome, reason: request.value.reason, at });
  if (!parsed.ok) throw new Error(parsed.error); return parsed.value;
};
