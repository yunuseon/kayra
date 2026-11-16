import { z } from "zod";
import { parseManagedAdmissionIdentity } from "../../contracts/managed-admission.ts";
import type { ManagedAdmissionClaim, ManagedAdmissionIdentity } from "../../contracts/managed-admission.ts";
import type { SwarmHostObservation } from "../../contracts/resource-authority.ts";
import { all, err, ok } from "../../lib/result.ts";
import { managedAdmissionDescription, reserveManagedTransition } from "./managed-transition.ts";
import { managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import { parseResourceBook, settleResources } from "./resource-book.ts";

const schema = z.object({ resources: z.unknown().nullable(), bindings: z.array(z.unknown()).max(1024).readonly() }).strict().readonly();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const sequence = (identity: ManagedAdmissionIdentity) => Number(identity.action.split(":")[1]);

/** Pure accounting projection. The index must synchronize resources and bindings in the same replacement, under its existing global writer. Legacy charges remain in this same book. */
export const parseManagedAdmissionAccounting = (input: unknown) => {
  const raw = schema.safeParse(input); if (!raw.success) return err("invalid managed admission accounting");
  const resources = raw.data.resources === null ? null : parseResourceBook(raw.data.resources);
  const bindings = all(raw.data.bindings.map(parseManagedAdmissionIdentity));
  if (resources !== null && !resources.ok || !bindings.ok) return err("invalid managed admission book or bindings");
  const book = resources?.value ?? null;
  if (new Set(bindings.value.map((value) => value.owner.app)).size !== bindings.value.length || bindings.value.some((value) => {
    const charge = book?.charges.find((item) => item.app === value.owner.app);
    return charge?.incarnation !== value.owner.incarnation || charge.sequence !== sequence(value) || charge.target.plan !== value.plan || charge.deadline !== value.deadline;
  })) return err("managed admission binding disagrees with resource charge");
  return ok(Object.freeze({ resources: book, bindings: Object.freeze(bindings.value.toSorted((a, b) => a.owner.app < b.owner.app ? -1 : a.owner.app > b.owner.app ? 1 : 0)) }));
};
export type ManagedAdmissionAccounting = Extract<ReturnType<typeof parseManagedAdmissionAccounting>, { readonly ok: true }>["value"];

const claimFor = (requested: ManagedAdmissionIdentity, input: ManagedAdmissionClaim) => {
  const identity = parseManagedAdmissionIdentity(requested); const claim = managedAdmissionDescription(input.plan, input.previous);
  if (!identity.ok || !claim.ok || !same(identity.value.owner, claim.value.plan.infrastructure.ownership) || identity.value.plan !== claim.value.planDigest || !same(claim.value.resources, input.resources) || claim.value.rollbackEligible !== input.rollbackEligible || input.planDigest !== claim.value.planDigest) return err("managed admission identity or immutable claim disagrees");
  return ok(Object.freeze({ identity: identity.value, claim: claim.value }));
};

/** A matching numeric sequence on a legacy charge is never permission to adopt it as a managed run. */
export const observeManagedAdmission = (input: unknown, requested: ManagedAdmissionIdentity, claim: ManagedAdmissionClaim) => {
  const state = parseManagedAdmissionAccounting(input); const checked = claimFor(requested, claim);
  if (!state.ok || !checked.ok) return err("managed admission observation is invalid");
  const identity = checked.value.identity; const charge = state.value.resources?.charges.find((item) => item.app === identity.owner.app);
  if (charge === undefined) return ok("absent" as const);
  if (charge.incarnation === identity.owner.incarnation && charge.sequence < sequence(identity) && charge.result !== "pending") return ok("absent" as const);
  const binding = state.value.bindings.find((value) => value.owner.app === identity.owner.app);
  if (!same(binding, identity)) return ok("foreign" as const);
  const expected = checked.value.claim;
  if (!same(charge.target, { plan: expected.planDigest, budget: expected.resources.target }) || !same(charge.previous, expected.previous === null || expected.resources.previous === null ? null : { plan: managedApplicationDigest(expected.previous), budget: expected.resources.previous }) || !same(charge.peak, expected.resources.peak)) return err("managed admission charge changed");
  return ok(charge.result === "pending" ? "reserved" as const : charge.result === "target" ? "settled-target" as const : charge.result === "previous" ? "settled-previous" as const : "settled-absent" as const);
};

/** No I/O and no authorization. The trusted caller separately verifies the indexed owner, persisted lifecycle intent, current host observation and operator grants before synchronizing this result. */
export const reserveManagedAdmission = (input: unknown, observation: SwarmHostObservation, requested: ManagedAdmissionIdentity, claim: ManagedAdmissionClaim, now: number) => {
  const state = parseManagedAdmissionAccounting(input); const checked = claimFor(requested, claim); const observed = observeManagedAdmission(input, requested, claim);
  if (!state.ok || !checked.ok || !observed.ok || observed.value !== "absent" && observed.value !== "reserved") return err("managed admission reservation conflicts");
  const identity = checked.value.identity;
  const next = reserveManagedTransition(state.value.resources, observation, checked.value.claim, sequence(identity), identity.deadline, now);
  return next.ok ? parseManagedAdmissionAccounting({ resources: next.value, bindings: [...state.value.bindings.filter((value) => value.owner.app !== identity.owner.app), identity] }) : next;
};

/** Only the lifecycle owner may supply the verified terminal outcome. Expiry alone never permits settlement or removes the run binding. */
export const settleManagedAdmission = (input: unknown, requested: ManagedAdmissionIdentity, claim: ManagedAdmissionClaim, result: "target" | "previous" | "absent") => {
  const state = parseManagedAdmissionAccounting(input); const checked = claimFor(requested, claim); const observed = observeManagedAdmission(input, requested, claim);
  if (!state.ok || !checked.ok || !observed.ok || observed.value !== "reserved" && observed.value !== `settled-${result}`) return err("managed admission settlement conflicts");
  const identity = checked.value.identity; const next = settleResources(state.value.resources, identity.owner.app, identity.owner.incarnation, sequence(identity), result);
  return next.ok ? parseManagedAdmissionAccounting({ ...state.value, resources: next.value }) : next;
};
