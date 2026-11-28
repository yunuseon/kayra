import { createHash } from "node:crypto";
import { join } from "node:path";
import { matchRegistrationGeneration, type RegistrationGeneration } from "../../contracts/registration-generation.ts";
import { parseRegistrationOwnership } from "../../contracts/registration-ownership.ts";
import { err } from "../../lib/result.ts";
import { readPublicRegistrationGeneration } from "./public-registration.ts";
import { readRegistrationFile } from "./registration-file.ts";

/** Exact immutable publication only. The coordinator must still check its own owner and admission records. */
export const readRegistrationOwnership = async (directory: string, expected: RegistrationGeneration) => {
  const registration = await readPublicRegistrationGeneration(directory, expected);
  if (!registration.ok || registration.value.app.runtime !== "swarm") return err("registration ownership is unavailable");
  const metadata = registration.value.metadata;
  const key = createHash("sha256").update(metadata.app, "utf8").digest("hex");
  try {
    const raw: unknown = JSON.parse(await readRegistrationFile(join(directory, key, "generations", metadata.registrationGeneration, "ownership.json"), 0o444, 0));
    const reference = parseRegistrationOwnership(raw);
    if (!reference.ok || !matchRegistrationGeneration(reference.value.registration, metadata, metadata).ok) return err("registration ownership is unavailable");
    return reference;
  } catch { return err("registration ownership is unavailable"); }
};
