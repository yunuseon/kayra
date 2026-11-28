import { z } from "zod";
import { err, ok } from "../lib/result.ts";
import { parseRegistrationGeneration } from "./registration-generation.ts";

const identity = z.object({
  version: z.literal(1), request: z.uuid(),
  action: z.string().max(80), registration: z.unknown(),
}).strict();
const shape = identity.extend({
  status: z.literal("withdrawn"),
  observedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().readonly();

const withdrawalIdentity = (input: z.infer<typeof identity>) => {
  const registration = parseRegistrationGeneration(input.registration);
  if (!registration.ok) return registration;
  const sequence = Number(input.action.split(":")[1]);
  if (!Number.isSafeInteger(sequence) || sequence <= Number(registration.value.actionId.split(":")[1]) ||
    input.action !== registration.value.incarnation + ":" + String(sequence)) return err("registration withdrawal action disagrees");
  return ok(Object.freeze({ version: input.version, request: input.request, action: input.action, registration: registration.value }));
};

export const parseRegistrationWithdrawalIdentity = (input: unknown) => {
  const checked = identity.safeParse(input);
  return checked.success ? withdrawalIdentity(checked.data) : err("invalid registration withdrawal");
};

/** Platform evidence for an exact withdrawn publication under its registration writer. A missing file alone cannot produce this evidence. */
export const parseRegistrationWithdrawal = (input: unknown) => {
  const checked = shape.safeParse(input);
  if (!checked.success) return err("invalid registration withdrawal");
  const result = withdrawalIdentity(checked.data);
  return result.ok ? ok(Object.freeze({ ...checked.data, registration: result.value.registration })) : result;
};
