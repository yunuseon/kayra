import { createHash } from "node:crypto";
import { join } from "node:path";
import { matchRegistrationGeneration, parseRegistrationGeneration, type RegistrationGeneration } from "../../contracts/registration-generation.ts";
import { err, ok } from "../../lib/result.ts";
import { readRegistrationFile } from "./registration-file.ts";

const variable = /^[A-Z][A-Z0-9_]{0,127}$/;
const parseConfiguration = (input: unknown) => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const fields: readonly (readonly [string, unknown])[] = Object.entries(input);
  if (fields.length > 128 || !fields.every((entry): entry is readonly [string, string] =>
    variable.test(entry[0]) && typeof entry[1] === "string" && !entry[1].includes("\0"))) return undefined;
  return Object.freeze(Object.fromEntries(fields));
};

/** Read only the private generation selected from the public registration. */
export const readPrivateRegistration = async (
  directory: string, metadata: RegistrationGeneration, secretKeys: readonly string[], group: number,
) => {
  if (secretKeys.length > 128 || new Set(secretKeys).size !== secretKeys.length || !secretKeys.every((key) => variable.test(key))) return err("invalid registration secret keys");
  const checked = parseRegistrationGeneration(metadata);
  if (!checked.ok) return checked;
  const key = createHash("sha256").update(checked.value.app, "utf8").digest("hex");
  const generation = join(directory, key, "generations", checked.value.registrationGeneration);
  try {
    const manifest: unknown = JSON.parse(await readRegistrationFile(join(generation, "manifest.json"), 0o440, group));
    if (!matchRegistrationGeneration(manifest, metadata, metadata).ok) return err("private registration identity mismatch");
    const rawConfiguration: unknown = JSON.parse(await readRegistrationFile(join(generation, "configuration.json"), 0o440, group));
    const configuration = parseConfiguration(rawConfiguration);
    if (configuration === undefined || secretKeys.some((key) => Object.hasOwn(configuration, key))) return err("invalid private registration configuration");
    const secrets = await Promise.all(secretKeys.map(async (key) => [
      key, await readRegistrationFile(join(generation, "secrets", key), 0o440, group),
    ] as const));
    if (secrets.some(([, value]) => value.includes("\0"))) return err("invalid private registration secret");
    return ok(Object.freeze({ configuration, secrets: Object.freeze(Object.fromEntries(secrets)) }));
  } catch {
    return err("private registration is unavailable or invalid");
  }
};
