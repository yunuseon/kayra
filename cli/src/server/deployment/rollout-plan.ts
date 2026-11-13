import { parseRollout } from "../../contracts/rollout.ts";
import { parseRolloutPlan, rolloutMigrationDescription } from "../../contracts/rollout-plan.ts";
import type { RolloutPlan } from "../../contracts/rollout-plan.ts";
import type { HttpArtifact, HttpPlanScope } from "../../contracts/http-plan.ts";
import type { ComposeDescription } from "../../contracts/compose-description.ts";
import { compileHttpPlan } from "./http-plan.ts";
import { err } from "../../lib/result.ts";

/** The trusted caller supplies operator policy; no effect or grant is created by compilation. */
export const compileRolloutPlan = (scope: HttpPlanScope, artifact: HttpArtifact, description: ComposeDescription, migrationTimeoutCeilingSeconds: number) => {
  const rollout = parseRollout(artifact.rollout); if (!rollout.ok) return err("valid rollout declarations are required");
  const projection = compileHttpPlan(scope, { ...artifact, rollout: { ...rollout.value, migrations: [] } }, description);
  if (!projection.ok) return projection;
  return parseRolloutPlan({ version: 2, runtime: "swarm", workload: projection.value, rollout: rollout.value,
    policy: { version: 1, migrationTimeoutCeilingSeconds, schedulingSeconds: 90, cleanupSeconds: 30, maximumAttempts: 8 } });
};

/** The parent retains this description before creating the phase journal. */
export const rolloutMigrationSequence = (input: RolloutPlan, run: string) => {
  return rolloutMigrationDescription(input, run);
};
