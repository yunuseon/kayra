import { parseManagedServicePlan } from "../../contracts/managed-service-plan.ts";
import type { ManagedServicePlan } from "../../contracts/managed-service-plan.ts";
import type { RetainedInputsPort } from "../../contracts/service-inputs.ts";
import { err, ok } from "../../lib/result.ts";

/** Reuse the recorded specification and generation; ordinary rollouts cannot upgrade dependencies. */
export const retainService = async (previous: ManagedServicePlan, candidate: ManagedServicePlan, inputs: RetainedInputsPort) => {
  const before = parseManagedServicePlan(previous); const after = parseManagedServicePlan(candidate);
  if (!before.ok || !after.ok || before.value.role !== "retained-dependency") return err("invalid retained service plans");
  const withoutInputs = (plan: ManagedServicePlan) => Object.freeze(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "inputs")));
  if (JSON.stringify(withoutInputs(before.value)) !== JSON.stringify(withoutInputs(after.value))) return err("retained dependency specification changed; a separate operation is required");
  const comparison = await inputs.compare(before.value.inputs, after.value.inputs).catch(() => "unavailable" as const);
  return comparison === "unchanged" ? ok<ManagedServicePlan>(before.value) : err(comparison === "changed" ? "retained dependency inputs changed; a separate operation is required" : "retained dependency input evidence is unavailable");
};
