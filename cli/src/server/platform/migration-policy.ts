import { parseMigrationPolicy } from "../../contracts/migration-policy.ts";
import { err } from "../../lib/result.ts";
import { readRegistrationFile } from "./registration-file.ts";

/** Host setup publishes the root-owned policy; admission captures its value in each immutable plan. */
export const readMigrationPolicy = async (path: string) => {
  try {
    const input: unknown = JSON.parse(await readRegistrationFile(path, 0o444, 0));
    return parseMigrationPolicy(input);
  } catch {
    return err("host migration policy is unavailable or invalid");
  }
};
