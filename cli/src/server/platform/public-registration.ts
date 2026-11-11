import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseApp } from "../../contracts/app-registration.ts";
import type { AppName } from "../../contracts/identity.ts";
import { matchRegistrationGeneration, parseRegistrationGeneration } from "../../contracts/registration-generation.ts";
import { err, ok } from "../../lib/result.ts";

import { readRegistrationFile } from "./registration-file.ts";

const readPublicRegistrationFile = async (path: string) => {
  const value: unknown = JSON.parse(await readRegistrationFile(path, 0o444, 0));
  return value;
};

/** Resolve one immutable public generation from the platform's current pointer. */
export const readPublicRegistration = async (directory: string, app: AppName) => {
  const key = createHash("sha256").update(app, "utf8").digest("hex");
  const root = join(directory, key);
  try {
    const pointer = parseRegistrationGeneration(await readPublicRegistrationFile(join(root, "current.json")));
    if (!pointer.ok || pointer.value.app !== app) return err("invalid public registration pointer");
    const generation = join(root, "generations", pointer.value.registrationGeneration);
    const manifest = await readPublicRegistrationFile(join(generation, "manifest.json"));
    const matching = matchRegistrationGeneration(manifest, pointer.value, pointer.value);
    if (!matching.ok) return matching;
    const registration = parseApp(app, await readPublicRegistrationFile(join(generation, "registration.json")));
    return registration.ok ? ok(Object.freeze({ metadata: matching.value, app: registration.value })) : err("invalid public registration payload");
  } catch {
    return err("public registration is unavailable or invalid");
  }
};
