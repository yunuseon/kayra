import { z } from "zod";
import { err, ok } from "../lib/result.ts";
import { parseRegistrationGeneration } from "./registration-generation.ts";

const shape = z.object({
  version: z.literal(1), status: z.literal("withdrawn"), request: z.uuid(),
  action: z.string().max(80), registration: z.unknown(),
  observedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().readonly();

/** Platform evidence for an exact withdrawn publication under its registration writer. A missing file alone cannot produce this evidence. */
export const parseRegistrationWithdrawal = (input: unknown) => {
  const checked = shape.safeParse(input);
  if (!checked.success) return err("invalid registration withdrawal");
  const registration = parseRegistrationGeneration(checked.data.registration);
  if (!registration.ok) return registration;
  const sequence = Number(checked.data.action.split(":")[1]);
  if (!Number.isSafeInteger(sequence) || sequence <= Number(registration.value.actionId.split(":")[1]) ||
    checked.data.action !== registration.value.incarnation + ":" + String(sequence)) return err("registration withdrawal action disagrees");
  return ok(Object.freeze({ ...checked.data, registration: registration.value }));
};
