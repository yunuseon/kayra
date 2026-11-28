import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { parseRegistrationGeneration } from "../../contracts/registration-generation.ts";
import type { RegistrationGeneration } from "../../contracts/registration-generation.ts";
import { parseRegistrationWithdrawal } from "../../contracts/registration-withdrawal.ts";
import { readRegistrationFile } from "./registration-file.ts";

type Expected = {
  readonly registration: RegistrationGeneration;
  readonly request: string;
  readonly action: string;
};
const missing = (error: unknown) => error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";

/** Reads only a root-owned withdrawal marker and the current publication path in the read-only platform mount. */
export const registrationWithdrawalObservation = (directory: string, now: () => number = Date.now) => async (expected: Expected) => {
  const identity = parseRegistrationGeneration(expected.registration);
  if (!identity.ok) return undefined;
  const key = createHash("sha256").update(identity.value.app, "utf8").digest("hex");
  const path = join(directory, key);
  try {
    const [intent, completed] = await Promise.all([
      readRegistrationFile(join(path, "withdrawal.json"), 0o444, 0),
      readRegistrationFile(join(path, "withdrawn.json"), 0o444, 0),
    ]);
    if (intent !== completed) return undefined;
    const raw: unknown = JSON.parse(completed);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw) ||
      Object.keys(raw).length !== 4 || !["version", "request", "action", "registration"].every((key) => Object.hasOwn(raw, key))) return undefined;
    const current = await lstat(join(path, "current.json")).catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw error;
    });
    if (current !== undefined) return undefined;
    const result = parseRegistrationWithdrawal({ ...raw, status: "withdrawn", observedAt: now() });
    return result.ok && result.value.request === expected.request && result.value.action === expected.action &&
      JSON.stringify(result.value.registration) === JSON.stringify(identity.value) ? result.value : undefined;
  } catch { return undefined; }
};
