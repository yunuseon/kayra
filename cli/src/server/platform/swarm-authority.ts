import { parseSwarmAuthority } from "../../contracts/swarm-authority.ts";
import { err } from "../../lib/result.ts";
import { readRegistrationFile } from "./registration-file.ts";

/** Only the platform setup publishes this root-owned read-only file. */
export const readSwarmAuthority = async (path: string) => {
  try {
    const input: unknown = JSON.parse(await readRegistrationFile(path, 0o444, 0));
    return parseSwarmAuthority(input);
  } catch {
    return err("Swarm host authority is unavailable or invalid");
  }
};
