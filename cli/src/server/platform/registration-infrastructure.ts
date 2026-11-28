import { createHash } from "node:crypto";
import { join } from "node:path";
import type { RegistrationGeneration } from "../../contracts/registration-generation.ts";
import { parseRegistrationInfrastructure } from "../../contracts/registration-infrastructure.ts";
import { parseSwarmAuthority } from "../../contracts/swarm-authority.ts";
import type { SwarmAuthority } from "../../contracts/swarm-authority.ts";
import { err } from "../../lib/result.ts";
import { readRegistrationOwnership } from "./registration-ownership.ts";
import { readRegistrationFile } from "./registration-file.ts";

/** No current-pointer fallback or inferred grant for older registrations. This read performs no native effects. */
export const readRegistrationInfrastructure = async (directory: string, expected: RegistrationGeneration, host: SwarmAuthority) => {
  const ownership = await readRegistrationOwnership(directory, expected); const authority = parseSwarmAuthority(host);
  if (!ownership.ok || !authority.ok) return err("registration infrastructure is unavailable");
  const metadata = ownership.value.registration;
  const key = createHash("sha256").update(metadata.app, "utf8").digest("hex");
  try {
    const raw: unknown = JSON.parse(await readRegistrationFile(join(directory, key, "generations", metadata.registrationGeneration, "infrastructure.json"), 0o444, 0));
    const reference = parseRegistrationInfrastructure(raw);
    if (!reference.ok) return err("registration infrastructure is unavailable");
    const { overlay, ...owner } = reference.value;
    if (JSON.stringify(owner) !== JSON.stringify(ownership.value) || overlay.scope.node !== authority.value.node || overlay.scope.cluster !== authority.value.cluster || overlay.id === authority.value.network.id) return err("registration infrastructure is unavailable");
    return reference;
  } catch { return err("registration infrastructure is unavailable"); }
};
