import { createHash } from "node:crypto";
import { managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import { observeManagedAdmission, parseManagedAdmissionAccounting } from "./managed-admission-binding.ts";
import { managedLifecycleDescription } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleRequest } from "./managed-lifecycle-request.ts";
import type { ManagedRemovalInventory } from "./managed-removal-effects.ts";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Plans the exact accounting replacement under the app and index writers. Runtime proof and the durable intent are checked by the owning index. */
export const managedRemovalAccounting = (input: unknown, inventory: ManagedRemovalInventory, requests: readonly ManagedLifecycleRequest[], retired?: string) => {
  const current = parseManagedAdmissionAccounting(input);
  if (!current.ok) throw new Error(current.error);
  const { resources, bindings } = current.value;
  const { intent, blocked } = inventory;
  const binding = bindings.find((item) => item.owner.app === intent.owner.app);
  const charge = resources?.charges.find((item) => item.app === intent.owner.app);
  const before = digest({ binding: binding ?? null, charge: charge ?? null });
  if (charge === undefined && binding === undefined) {
    if (blocked !== null && (blocked.state.operation.admitted || blocked.source.previous !== null)) throw new Error("managed removal lost its resource charge");
    return Object.freeze({ before, after: before, resources });
  }
  const request = requests.find((item) => item.run === binding?.run);
  if (resources === null || blocked === null || charge === undefined || binding === undefined || request === undefined ||
    !same(binding.owner, intent.owner) || request.source !== binding.source || request.action !== binding.action ||
    request.plan !== binding.plan || request.admissionDeadline !== binding.deadline ||
    charge.sequence >= Number(intent.action.split(":")[1])) throw new Error("managed removal cannot identify its resource charge");

  if (charge.result === "absent" && before === retired) return Object.freeze({ before, after: before, resources });

  const { state, source } = blocked;
  const claim = managedLifecycleDescription(source).admission;
  if (binding.run === state.operation.run) {
    const observed = observeManagedAdmission(current.value, binding, claim);
    if (!observed.ok || observed.value === "absent" || observed.value === "foreign" || binding.source !== state.operation.source) throw new Error("managed removal charge disagrees with the checkpoint");
  } else {
    const active = charge.result === "target" ? charge.target : charge.result === "previous" ? charge.previous : null;
    const previous = claim.previous === null ? null : { plan: managedApplicationDigest(claim.previous), budget: claim.resources.previous };
    // A candidate can be journaled before admission, while the previous release still owns capacity.
    if (charge.sequence >= state.sequence || state.operation.admitted || charge.result === "pending" ||
      request.completion === null || !same(active, previous)) throw new Error("managed removal previous charge disagrees with the checkpoint");
  }

  const absent = Object.freeze({ ...charge, result: "absent" as const });
  const next = parseManagedAdmissionAccounting({
    resources: { ...resources, charges: resources.charges.map((item) => item === charge ? absent : item) },
    bindings,
  });
  if (!next.ok) throw new Error(next.error);
  return Object.freeze({ before, after: digest({ binding, charge: absent }), resources: next.value.resources });
};
