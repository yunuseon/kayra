import { parseManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import { err, ok } from "../../lib/result.ts";
import { parseManagedGroupCompensation } from "./managed-group-compensation.ts";

const canonical = (values: ManagedLifecycleSource["retired"]) => JSON.stringify(values.toSorted((a, b) => a.plan.service < b.plan.service ? -1 : a.plan.service > b.plan.service ? 1 : 0));

/** Successful-run carry only. Recovery/removal must supply their separately verified inactive inventory, never guess it from candidate files. */
export const managedSuccessfulInventoryCarry = (previous: ManagedLifecycleSource | null, next: ManagedLifecycleSource) => {
  const source = parseManagedLifecycleSource(next);
  if (previous === null) return source.retained.length === 0 && source.retired.length === 0 ? ok(undefined) : err("new managed lifecycle cannot adopt unrecorded retained or retired workloads");
  const before = parseManagedLifecycleSource(previous);
  const inactive = before.retired.filter((value) => before.candidate.services[value.plan.service] === undefined);
  return canonical(inactive) === canonical(source.retired) ? ok(undefined) : err("managed lifecycle must preserve its recorded inactive dependency inventory");
};

/** A failed new dependency stays owned and pinned after its containers are scrubbed. The restored application's verified release owns active dependencies. */
export const managedRecoveredInventoryCarry = (input: ManagedLifecycleSource, recovered: unknown, next: ManagedLifecycleSource) => {
  const source = parseManagedLifecycleSource(input); const candidate = parseManagedLifecycleSource(next); const recovery = parseManagedGroupCompensation(recovered);
  if (recovery.phase !== "verified" || recovery.run !== source.run || recovery.action !== source.action || recovery.app !== source.candidate.infrastructure.ownership.app || recovery.incarnation !== source.candidate.infrastructure.ownership.incarnation || recovery.dataOwner !== source.candidate.infrastructure.ownership.dataOwner) return err("managed retired inventory lacks verified recovery ownership");
  const inactive = recovery.nodes.flatMap((node) => {
    const spec = source.candidate.services[node.name]; const barrier = node.child?.barrier;
    return spec?.role === "retained-dependency" && source.previous?.source.application.services[node.name] === undefined && barrier?.phase === "complete" ? Object.freeze([Object.freeze({ plan: spec, barrier })]) : Object.freeze([]);
  });
  const retained = [...source.retired.filter((item) => !inactive.some((value) => value.plan.service === item.plan.service) && source.previous?.source.application.services[item.plan.service] === undefined), ...inactive];
  return canonical(retained) === canonical(candidate.retired) ? ok(undefined) : err("managed lifecycle must preserve dependencies retired by verified recovery");
};

/** An unstarted candidate never reactivated or retired a dependency. Preserve the entire authenticated inactive inventory. */
export const managedUnstartedInventoryCarry = (previous: ManagedLifecycleSource, next: ManagedLifecycleSource) => {
  const before = parseManagedLifecycleSource(previous); const after = parseManagedLifecycleSource(next);
  return canonical(before.retired) === canonical(after.retired) ? ok(undefined) : err("unstarted lifecycle must preserve its inactive dependency inventory");
};
