import { createHash } from "node:crypto";
import { z } from "zod";
import { parseApplicationPlan } from "./application-plan.ts";
import type { ApplicationPlan } from "./http-plan.ts";
import { parseRollout, validateAdmission } from "./rollout.ts";
import type { Rollout } from "./rollout.ts";
import { parseMigrationSequencePlan } from "./migration-sequence.ts";
import type { MigrationSequencePlan } from "./migration-sequence.ts";
import { typed } from "../lib/typed.ts";
import { err, ok } from "../lib/result.ts";
import type { RegistrationGeneration } from "./registration-generation.ts";
import type { Runtime } from "./rollout.ts";

const policySchema = z.object({ version: z.literal(1), migrationTimeoutCeilingSeconds: z.number().int().min(1).max(86400),
  schedulingSeconds: z.literal(90), cleanupSeconds: z.literal(30), maximumAttempts: z.literal(8),
}).strict().readonly();
const schema = z.object({ version: z.literal(2), runtime: z.literal("swarm"), workload: z.unknown(), rollout: z.unknown(), policy: policySchema }).strict();
export type RolloutPlan = {
  readonly version: 2; readonly runtime: "swarm"; readonly workload: ApplicationPlan; readonly rollout: Rollout;
  readonly policy: z.infer<typeof policySchema>;
};
export type RolloutPlanPort = {
  readonly preview: (registration: RegistrationGeneration, runtime: Runtime, commit: string, artifact: string) => Promise<RolloutPlan>;
};
const same = (first: unknown, second: unknown) => JSON.stringify(first) === JSON.stringify(second);
const migrationDescription = (projection: ApplicationPlan, rollout: Rollout, policy: RolloutPlan["policy"], deployment: string, run: string) => {
  const name = Object.keys(projection.services)[0]; const spec = name === undefined ? undefined : projection.services[name];
  if (spec === undefined || rollout.migrations.length === 0) return err("rollout has no migration sequence");
  return parseMigrationSequencePlan({ version: 1, deployment, scope: { app: projection.app, incarnation: projection.registration.incarnation, run },
    policy: { schedulingSeconds: policy.schedulingSeconds, cleanupSeconds: policy.cleanupSeconds,
      maximumAttempts: policy.maximumAttempts, timeoutCeilingSeconds: policy.migrationTimeoutCeilingSeconds },
    steps: rollout.migrations.map((definition) => typed<MigrationSequencePlan["steps"][number]>({ definition, template: { version: 1, image: spec.image,
      entrypoint: spec.entrypoint, environment: spec.environment, resources: { memoryBytes: spec.resources.memoryBytes, nanoCpus: spec.resources.nanoCpus },
      networks: [projection.host.network.id], stopGraceSeconds: spec.stopGraceSeconds } })) });
};

/** Version two keeps orchestration declarations outside the version-one HTTP adapter projection. */
export const parseRolloutPlan = (input: unknown) => {
  const parsed = schema.safeParse(input); if (!parsed.success) return err("invalid immutable rollout plan");
  const value = parsed.data; const workload = parseApplicationPlan(value.workload); const rollout = parseRollout(value.rollout);
  if (!workload.ok || !rollout.ok) return err("invalid rollout workload or declarations");
  const projection = workload.value; const names = Object.keys(projection.services); const service = names[0];
  const admitted = validateAdmission({ runtime: "swarm", existingRuntime: "swarm", swarmEnabled: true, maintenanceGranted: projection.grants.maintenance,
    capabilities: ["rolling-http", "migrations"], rollout: rollout.value, composeServices: names, routedServices: projection.routes.map((route) => route.service),
    migrationTimeoutCeilingSeconds: value.policy.migrationTimeoutCeilingSeconds, checkTimeoutCeilingSeconds: 90 });
  if (!admitted.ok || service === undefined || !same({ ...rollout.value, migrations: [] }, projection.rollout)) return err("unsupported rollout or mismatched HTTP projection");
  if (rollout.value.migrations.some((step) => step.service !== service)) return err("migration references an unsupported service");
  if (rollout.value.migrations.length > 0) {
    const sequence = migrationDescription(projection, rollout.value, value.policy, "0".repeat(64), "00000000-0000-4000-8000-000000000001");
    if (!sequence.ok) return err(sequence.error);
  }
  return ok<RolloutPlan>(Object.freeze({ ...value, workload: projection, rollout: rollout.value }));
};

export const rolloutPlanDigest = (input: RolloutPlan) => {
  const parsed = parseRolloutPlan(input); if (!parsed.ok) throw new Error(parsed.error);
  return createHash("sha256").update(JSON.stringify(parsed.value)).digest("hex");
};

/** A private HTTP projection is independently retained and checked by the runtime adapter. */
export const rolloutWorkloadDigest = (input: RolloutPlan) => {
  const parsed = parseRolloutPlan(input); if (!parsed.ok) throw new Error(parsed.error);
  return createHash("sha256").update(JSON.stringify(parsed.value.workload)).digest("hex");
};

export const rolloutMigrationDescription = (input: RolloutPlan, run: string) => {
  const parsed = parseRolloutPlan(input); if (!parsed.ok) return parsed;
  const plan = parsed.value;
  return migrationDescription(plan.workload, plan.rollout, plan.policy, createHash("sha256").update(JSON.stringify(plan)).digest("hex"), run);
};

/** Budgets are finite; job retry windows are shared rather than multiplied per attempt. */
export const rolloutOperationSeconds = (input: RolloutPlan) => {
  const parsed = parseRolloutPlan(input); if (!parsed.ok) throw new Error(parsed.error);
  const plan = parsed.value;
  const migrations = plan.rollout.migrations.reduce((total, step) => total + plan.policy.schedulingSeconds + step.timeout_seconds +
    plan.policy.cleanupSeconds * plan.policy.maximumAttempts + (step.recovery.kind === "status-probe" ? plan.policy.schedulingSeconds + step.recovery.timeout_seconds + plan.policy.cleanupSeconds : 0), 0);
  return Math.max(plan.policy.schedulingSeconds, migrations) + plan.workload.policy.updateTimeoutSeconds + plan.workload.policy.rollbackTimeoutSeconds;
};
