import { z } from "zod";
import type { ManagedApplicationPlan } from "./managed-application-plan.ts";
import type { ResourceBudget } from "./resource-authority.ts";
import { parseDataOwnership } from "./owned-volume.ts";
import { err, ok } from "../lib/result.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.object({ owner: z.unknown(), run: z.uuid(), action: z.string().max(80), source: digest, plan: digest, deadline: positive }).strict().readonly();
export const parseManagedAdmissionIdentity = (input: unknown) => {
  const checked = schema.safeParse(input); if (!checked.success) return err("invalid managed admission identity");
  const owner = parseDataOwnership(checked.data.owner);
  if (!owner.ok || !new RegExp(`^${owner.value.incarnation}:[1-9][0-9]*$`).test(checked.data.action) || !Number.isSafeInteger(Number(checked.data.action.split(":")[1]))) return err("invalid managed admission scope");
  return ok(Object.freeze({ ...checked.data, owner: owner.value }));
};
export type ManagedAdmissionIdentity = Extract<ReturnType<typeof parseManagedAdmissionIdentity>, { readonly ok: true }>["value"];
export type ManagedAdmissionClaim = {
  readonly plan: ManagedApplicationPlan; readonly previous: ManagedApplicationPlan | null; readonly planDigest: string; readonly rollbackEligible: boolean;
  readonly resources: { readonly target: ResourceBudget; readonly previous: ResourceBudget | null; readonly peak: ResourceBudget;
    readonly frames: { readonly startup: ResourceBudget; readonly migration: ResourceBudget; readonly recovery: ResourceBudget } };
};
/** The composition root supplies the existing single accounting writer, shared with legacy Swarm admissions. No independent book may ignore existing charges. */
export type ManagedAdmissionPort = {
  /** Identity deadline is the admission scheduling ceiling; an admitted pending charge survives its expiry. Idempotent synchronization under the original identity/deadline; independently revalidate the immutable claim before writing. */
  readonly reserve: (identity: ManagedAdmissionIdentity, claim: ManagedAdmissionClaim) => Promise<"reserved" | "refused" | "uncertain">;
  readonly observe: (identity: ManagedAdmissionIdentity, claim: ManagedAdmissionClaim) => Promise<"reserved" | "settled-target" | "settled-previous" | "settled-absent" | "absent" | "foreign" | "unavailable">;
  /** A pending/expired lease stays charged until the owning lifecycle supplies complete effect-fencing evidence. */
  readonly settle: (identity: ManagedAdmissionIdentity, claim: ManagedAdmissionClaim, result: "target" | "previous" | "absent") => Promise<"settled" | "uncertain" | "refused">;
};
