import { z } from "zod";
import { parseAppOverlayGrant } from "./app-overlay.ts";
import type { AppOverlayGrant } from "./app-overlay.ts";
import { parseRegistrationOwnership } from "./registration-ownership.ts";
import type { RegistrationOwnership } from "./registration-ownership.ts";
import { err, ok } from "../lib/result.ts";

const schema = z.object({ version: z.literal(1), runtime: z.literal("swarm"), registration: z.unknown(), ownership: z.unknown(), overlay: z.unknown() }).strict();
export type RegistrationInfrastructure = RegistrationOwnership & { readonly overlay: AppOverlayGrant };
/** Published infrastructure identity only. Admission must still verify current host, ownership and physical observations. */
export const parseRegistrationInfrastructure = (input: unknown) => {
  const checked = schema.safeParse(input); if (!checked.success) return err("invalid registration infrastructure reference");
  const { overlay, ...reference } = checked.data; const owner = parseRegistrationOwnership(reference); const grant = parseAppOverlayGrant(overlay);
  if (!owner.ok || !grant.ok || owner.value.registration.app !== grant.value.scope.app || owner.value.registration.incarnation !== grant.value.scope.incarnation) return err("registration infrastructure scope disagrees");
  return ok<RegistrationInfrastructure>(Object.freeze({ ...owner.value, overlay: grant.value }));
};
