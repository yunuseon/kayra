import { parseManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { parseJobPlan } from "../../contracts/one-shot-job.ts";
import type { JobPlan } from "../../contracts/one-shot-job.ts";
import { err, ok } from "../../lib/result.ts";

/** Reference selection only. The parent sequence separately authenticates run, artifact, deadlines and admission before any runtime effect. */
export const managedMigrationInputs = (input: ManagedApplicationPlan, job: JobPlan) => {
  const checked = parseManagedApplicationPlan(input); const execution = parseJobPlan(job);
  if (!checked.ok || !execution.ok) return err("invalid managed migration input request");
  const plan = checked.value; const requested = execution.value;
  const definition = plan.rollout.migrations.find((step) => step.id === requested.scope.step);
  const service = definition === undefined ? undefined : plan.services[definition.service];
  if (definition === undefined || service === undefined || requested.scope.app !== plan.infrastructure.registration.app || requested.scope.incarnation !== plan.infrastructure.registration.incarnation) return err("managed migration input ownership disagrees");
  const command = requested.scope.purpose === "migration" ? definition.command : definition.recovery.kind === "status-probe" ? definition.recovery.command : null;
  const expected = { version: 1, scope: requested.scope, command, image: service.image, entrypoint: service.entrypoint, environment: service.inputs.environment,
    resources: { memoryBytes: service.resources.memoryBytes, nanoCpus: service.resources.nanoCpus }, networks: [service.privateNetwork.id], stopGraceSeconds: service.stopGraceSeconds,
    deadline: requested.deadline, ...(requested.startDeadline === undefined ? {} : { startDeadline: requested.startDeadline }),
    ...(requested.executionTimeoutSeconds === undefined ? {} : { executionTimeoutSeconds: requested.executionTimeoutSeconds }),
  };
  const description = parseJobPlan(expected);
  return description.ok && JSON.stringify(description.value) === JSON.stringify(requested) ? ok(service.inputs) : err("managed migration description disagrees with input reference");
};
