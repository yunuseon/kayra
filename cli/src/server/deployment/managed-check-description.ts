import { managedApplicationDigest, parseManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import { parseCheckTarget, parseContainerCheckPlan } from "../../contracts/container-check.ts";
import type { CheckTarget } from "../../contracts/container-check.ts";
import { err } from "../../lib/result.ts";

/** A check uses the existing admitted container, including its mounts and configuration. No one-shot replacement or new environment is synthesized. */
export const describeManagedCheck = (input: ManagedApplicationPlan, run: string, name: string, target: CheckTarget, deadline: number) => {
  const checked = parseManagedApplicationPlan(input); const reference = parseCheckTarget(target); if (!checked.ok || !reference.ok) return err("invalid managed application check input");
  const plan = checked.value; const selected = plan.rollout.checks.find((check) => check.id === name); const service = plan.services[reference.value.action.service];
  if (selected?.service !== reference.value.action.service || service === undefined || reference.value.action.app !== plan.infrastructure.ownership.app || reference.value.action.incarnation !== plan.infrastructure.ownership.incarnation || reference.value.action.dataOwner !== plan.infrastructure.ownership.dataOwner || reference.value.action.plan !== managedServiceDigest(service) || selected.timeout_seconds > plan.policy.checkTimeoutCeilingSeconds || Object.hasOwn(service.inputs.environment, "KAYRA_OPERATION_ID")) return err("managed check scope, command or timeout disagrees");
  return parseContainerCheckPlan({ version: 1, application: managedApplicationDigest(plan), run, check: selected.id, target: reference.value, command: selected.command, deadline, timeoutSeconds: selected.timeout_seconds });
};
