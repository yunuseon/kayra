import { z } from "zod";
import { parseRegistrationGeneration } from "./registration-generation.ts";
import type { RegistrationGeneration } from "./registration-generation.ts";
import { parseDataOwnership } from "./owned-volume.ts";
import type { DataOwnership } from "./owned-volume.ts";
import { err, ok } from "../lib/result.ts";

const schema = z.object({ version: z.literal(1), runtime: z.literal("swarm"), registration: z.unknown(), ownership: z.unknown() }).strict();
/** Registration-scoped metadata only; not resource admission or permission to create infrastructure. */
export type RegistrationOwnership = { readonly version: 1; readonly runtime: "swarm"; readonly registration: RegistrationGeneration; readonly ownership: DataOwnership };
export const parseRegistrationOwnership = (input: unknown) => {
  const checked = schema.safeParse(input); if (!checked.success) return err("invalid registration ownership reference");
  const registration = parseRegistrationGeneration(checked.data.registration); const ownership = parseDataOwnership(checked.data.ownership);
  if (!registration.ok || !ownership.ok || registration.value.app !== ownership.value.app || registration.value.incarnation !== ownership.value.incarnation || ownership.value.dataOwner !== ownership.value.dataOwner.toLowerCase()) return err("registration ownership scope disagrees");
  return ok<RegistrationOwnership>(Object.freeze({ version: 1, runtime: "swarm", registration: registration.value, ownership: ownership.value }));
};
