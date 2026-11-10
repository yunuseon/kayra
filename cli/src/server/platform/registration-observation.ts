import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { parseRegistrationGeneration, parseRegistrationObservation, type RegistrationGeneration } from "../../contracts/registration-generation.ts";

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
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== 0 || info.gid !== 0 || info.mode !== 0o100444 || info.nlink !== 1 || info.size > 64 * 1024) return undefined;
    const evidence = parseRegistrationObservation(JSON.parse(await file.readFile("utf8")));
    signal.throwIfAborted();
    return evidence.ok ? evidence.value : undefined;
  } finally {
    await file.close();
  }
};
