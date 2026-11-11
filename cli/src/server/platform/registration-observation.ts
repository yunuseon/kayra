import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseRegistrationGeneration, parseRegistrationObservation, type RegistrationGeneration } from "../../contracts/registration-generation.ts";
import { readRegistrationFile } from "./registration-file.ts";

/** The composition root mounts a platform-owned evidence tree read-only, under trusted ancestors. */
export const registrationObservation = (directory: string) => async (
  expected: Omit<RegistrationGeneration, "version">,
  // eslint-disable-next-line functional/prefer-immutable-types -- supplied by the coordinator to cancel observation
  signal: AbortSignal,
) => {
  const identity = parseRegistrationGeneration({ ...expected, version: 1 });
  signal.throwIfAborted();
  if (!identity.ok) return undefined;
  const key = createHash("sha256").update(identity.value.app, "utf8").digest("hex");
  const path = join(directory, key, identity.value.registrationGeneration + ".json");
  const evidence = parseRegistrationObservation(JSON.parse(await readRegistrationFile(path, 0o444, 0)));
  signal.throwIfAborted();
  return evidence.ok ? evidence.value : undefined;
};
