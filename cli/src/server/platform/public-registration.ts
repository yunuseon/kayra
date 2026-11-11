import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseApp } from "../../contracts/app-registration.ts";
import type { AppName } from "../../contracts/identity.ts";
import { matchRegistrationGeneration, parseRegistrationGeneration, type RegistrationGeneration } from "../../contracts/registration-generation.ts";
import { err, ok } from "../../lib/result.ts";

import { readRegistrationFile } from "./registration-file.ts";

const readPublicRegistrationFile = async (path: string) => {
  const value: unknown = JSON.parse(await readRegistrationFile(path, 0o444, 0));
  return value;
};

/** Read the exact immutable generation supplied by the lifecycle owner. */
export const readPublicRegistrationGeneration = async (directory: string, expected: RegistrationGeneration) => {
  const identity = parseRegistrationGeneration(expected);
  if (!identity.ok) return identity;
  const metadata = identity.value;
  const key = createHash("sha256").update(metadata.app, "utf8").digest("hex");
  const generation = join(directory, key, "generations", metadata.registrationGeneration);
  try {
    const manifest = await readPublicRegistrationFile(join(generation, "manifest.json"));
    const matching = matchRegistrationGeneration(manifest, metadata, metadata);
    if (!matching.ok) return matching;
    const registration = parseApp(metadata.app, await readPublicRegistrationFile(join(generation, "registration.json")));
    return registration.ok ? ok(Object.freeze({ metadata: matching.value, app: registration.value })) : err("invalid public registration payload");
  } catch {
    return err("public registration is unavailable or invalid");
  }
};

/** Select a generation once from the platform pointer. Subsequent reads use its identity. */
export const readPublicRegistration = async (directory: string, app: AppName) => {
  const key = createHash("sha256").update(app, "utf8").digest("hex");
  try {
    const pointer = parseRegistrationGeneration(await readPublicRegistrationFile(join(directory, key, "current.json")));
    if (!pointer.ok || pointer.value.app !== app) return err("invalid public registration pointer");
    return await readPublicRegistrationGeneration(directory, pointer.value);
  } catch {
    return err("public registration is unavailable or invalid");
  }
};
