import { z } from "zod";
import { parseManagedAdmissionIdentity } from "../../contracts/managed-admission.ts";
import type { ManagedAdmissionClaim, ManagedAdmissionIdentity } from "../../contracts/managed-admission.ts";
import type { SwarmHostObservation } from "../../contracts/resource-authority.ts";
import { all, err, ok } from "../../lib/result.ts";
import { managedAdmissionDescription, reserveManagedTransition } from "./managed-transition.ts";
import { managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import { parseResourceBook, resourceHostReady, settleResources } from "./resource-book.ts";

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

/**
 * Replaces a pending charge and its binding in one snapshot. The owning index must authenticate the
 * continuation and verify current consumer cessation, retained readiness and operator grants before
 * synchronizing this result. This function does not settle the blocked run or activate the successor.
 */
export const transferManagedAdmission = (input: unknown, observation: SwarmHostObservation, blocked: { readonly identity: ManagedAdmissionIdentity; readonly claim: ManagedAdmissionClaim }, successor: { readonly identity: ManagedAdmissionIdentity; readonly claim: ManagedAdmissionClaim }, now: number) => {
  const state = parseManagedAdmissionAccounting(input);
  const before = claimFor(blocked.identity, blocked.claim);
  const after = claimFor(successor.identity, successor.claim);
  if (!state.ok || state.value.resources === null || !before.ok || !after.ok) return err("invalid managed admission transfer");
  const book = state.value.resources;
  const old = before.value.identity;
  const next = after.value.identity;
  const source = before.value.claim.plan;
  const target = after.value.claim.plan;
  if (!same(old.owner, next.owner) || next.run === old.run || sequence(next) <= sequence(old) ||
    next.source === old.source || after.value.claim.previous !== null ||
    source.rollout.strategy !== "maintenance" || target.rollout.strategy !== "maintenance" ||
    !same(source.host, target.host) || !same(book.host, target.host) ||
    !same(source.infrastructure.overlay, target.infrastructure.overlay)) return err("managed admission transfer scope disagrees");

  const previousServices = Object.values(before.value.claim.previous?.services ?? {});
  const live = [...Object.values(source.services), ...previousServices];
  if (live.some((service) => {
    const retained = target.services[service.service];
    return service.role === "retained-dependency" && (retained === undefined || managedServiceDigest(service) !== managedServiceDigest(retained)) ||
      service.role !== "retained-dependency" && retained?.role === "retained-dependency";
  })) return err("managed admission transfer changes retained workload accounting");

  const observed = observeManagedAdmission(state.value, next, after.value.claim);
  if (observed.ok && observed.value === "reserved") return state;
  const prior = observeManagedAdmission(state.value, old, before.value.claim);
  if (!prior.ok || prior.value !== "reserved") return err("managed admission transfer requires the exact pending blocked charge");
  if (!Number.isSafeInteger(now) || now < next.deadline - 90_000 || now >= next.deadline ||
    !resourceHostReady(book.host, observation)) return err("managed admission transfer requires a current host and scheduling window");

  const replacement = Object.freeze({
    app: next.owner.app, incarnation: next.owner.incarnation, sequence: sequence(next),
    previous: null, target: { plan: next.plan, budget: after.value.claim.resources.target },
    peak: after.value.claim.resources.peak, deadline: next.deadline, result: "pending",
  });
  return parseManagedAdmissionAccounting({
    resources: { ...book, charges: book.charges.map((item) => item.app === old.owner.app ? replacement : item) },
    bindings: state.value.bindings.map((item) => item.owner.app === old.owner.app ? next : item),
  });
};

/** Only the lifecycle owner may supply the verified terminal outcome. Expiry alone never permits settlement or removes the run binding. */
export const settleManagedAdmission = (input: unknown, requested: ManagedAdmissionIdentity, claim: ManagedAdmissionClaim, result: "target" | "previous" | "absent") => {
  const state = parseManagedAdmissionAccounting(input); const checked = claimFor(requested, claim); const observed = observeManagedAdmission(input, requested, claim);
  if (!state.ok || !checked.ok || !observed.ok || observed.value !== "reserved" && observed.value !== `settled-${result}`) return err("managed admission settlement conflicts");
  const identity = checked.value.identity; const next = settleResources(state.value.resources, identity.owner.app, identity.owner.incarnation, sequence(identity), result);
  return next.ok ? parseManagedAdmissionAccounting({ ...state.value, resources: next.value }) : next;
};

/** Metadata-only terminal fence. The caller must first durably prove that no workload effect has an intent. This also closes a delayed reservation racing cancellation, without requiring candidate capacity or a renewed deadline. */
export const fenceUnstartedManagedAdmission = (input: unknown, requested: ManagedAdmissionIdentity, claim: ManagedAdmissionClaim) => {
  const state = parseManagedAdmissionAccounting(input); const checked = claimFor(requested, claim); const observed = observeManagedAdmission(input, requested, claim);
  if (!state.ok || !checked.ok || !observed.ok) return err("invalid unstarted managed admission");
  const result = checked.value.claim.previous === null ? "absent" : "previous";
  if (observed.value === "reserved" || observed.value === `settled-${result}`) return settleManagedAdmission(input, requested, claim, result);
  if (observed.value !== "absent") return err("unstarted managed admission conflicts");
  const identity = checked.value.identity; const expected = checked.value.claim;
  const book = state.value.resources ?? { version: 1, host: expected.plan.host, charges: [] };
  if (!same(book.host, expected.plan.host)) return err("unstarted managed admission host changed");
  const old = book.charges.find((value) => value.app === identity.owner.app);
  const active = old?.result === "target" ? old.target : old?.result === "previous" ? old.previous : null;
  const previous = expected.previous === null || expected.resources.previous === null ? null : { plan: managedApplicationDigest(expected.previous), budget: expected.resources.previous };
  if (old?.result === "pending" || !same(active, previous)) return err("unstarted managed admission previous charge changed");
  const resources = { ...book, charges: [...book.charges.filter((value) => value.app !== identity.owner.app), {
    app: identity.owner.app, incarnation: identity.owner.incarnation, sequence: sequence(identity), previous,
    target: { plan: expected.planDigest, budget: expected.resources.target }, peak: expected.resources.peak, deadline: identity.deadline, result,
  }] };
  return parseManagedAdmissionAccounting({ resources, bindings: [...state.value.bindings.filter((value) => value.owner.app !== identity.owner.app), identity] });
};
