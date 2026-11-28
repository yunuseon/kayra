import { z } from "zod";
import { parseManagedApplicationPlan } from "./managed-application-plan.ts";
import { parseDataOwnership } from "./owned-volume.ts";
import { err, ok } from "../lib/result.ts";

const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({ version: z.literal(1), protocol: z.literal("managed-v3"), runtime: z.literal("swarm"),
  owner: z.unknown(), run: z.uuid(), action: z.string().max(80), source: z.string().regex(/^[a-f0-9]{64}$/),
  application: z.unknown(), previous: z.unknown().nullable(), allocationRequired: z.boolean(),
  createdAt: time, admissionDeadline: time, deadline: time,
}).strict().readonly();
/** Immutable operational inputs published by the deployment owner, not an execution grant or release certificate. No private journal shape or resolved secrets cross this port. */
export const parseManagedExecutionContext = (input: unknown) => {
  const raw = schema.safeParse(input); if (!raw.success) return err("invalid managed execution context");
  const value = raw.data; const owner = parseDataOwnership(value.owner); const application = parseManagedApplicationPlan(value.application); const previous = value.previous === null ? null : parseManagedApplicationPlan(value.previous);
  if (!owner.ok || !application.ok || previous !== null && !previous.ok || JSON.stringify(owner.value) !== JSON.stringify(application.value.infrastructure.ownership) || previous !== null && JSON.stringify(previous.value.infrastructure.ownership) !== JSON.stringify(owner.value) ||
    !new RegExp(`^${owner.value.incarnation}:[1-9][0-9]*$`).test(value.action) || !Number.isSafeInteger(Number(value.action.split(":")[1])) || value.admissionDeadline !== value.createdAt + 90_000 || value.deadline <= value.admissionDeadline) return err("managed execution context ownership disagrees");
  return ok(Object.freeze({ ...value, owner: owner.value, application: application.value, previous: previous?.value ?? null }));
};
export type ManagedExecutionContext = Extract<ReturnType<typeof parseManagedExecutionContext>, { readonly ok: true }>["value"];
