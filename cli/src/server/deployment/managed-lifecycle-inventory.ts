import { parseManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import { err, ok } from "../../lib/result.ts";

const canonical = (values: ManagedLifecycleSource["retired"]) => JSON.stringify(values.toSorted((a, b) => a.plan.service < b.plan.service ? -1 : a.plan.service > b.plan.service ? 1 : 0));

/** Successful-run carry only. Recovery/removal must supply their separately verified inactive inventory, never guess it from candidate files. */
export const managedSuccessfulInventoryCarry = (previous: ManagedLifecycleSource | null, next: ManagedLifecycleSource) => {
  const source = parseManagedLifecycleSource(next);
  if (previous === null) return source.retained.length === 0 && source.retired.length === 0 ? ok(undefined) : err("new managed lifecycle cannot adopt unrecorded retained or retired workloads");
  const before = parseManagedLifecycleSource(previous);
  const inactive = before.retired.filter((value) => before.candidate.services[value.plan.service] === undefined);
  return canonical(inactive) === canonical(source.retired) ? ok(undefined) : err("managed lifecycle must preserve its recorded inactive dependency inventory");
};
