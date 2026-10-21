import type { AbsolutePath, AgeKeyFile } from "../fleet/brand.ts";
import { spawned, type Plumbing } from "../interpreter/process.ts";
import type { Env } from "../plan/model.ts";
import { err, ok, type Result } from "../../lib/result.ts";
import { typed } from "../../lib/typed.ts";

/** SOPS, as kayra uses it: a file's values opened, and one value set in place. */
export type Sops = {
  readonly decrypt: (file: AbsolutePath, key: AgeKeyFile | undefined, plumbing?: Plumbing) => Promise<Result<string, string>>;
  /** Sets one value at a path of keys, leaving every other value's ciphertext as it was; nothing changes if it is already that value. */
  readonly set: (file: AbsolutePath, path: readonly string[], value: string, key: AgeKeyFile | undefined) => Promise<Result<undefined, string>>;
};

/** Where SOPS finds the age identity: the server's age_key_file, else its own defaults (SOPS_AGE_KEY_FILE, ~/.config/sops/age/keys.txt). */
export const keyEnv = (key: AgeKeyFile | undefined) => typed<Env>(key === undefined ? {} : { SOPS_AGE_KEY_FILE: key });

/** SOPS's own error, its first line; the plugin's when the Secure Enclave or Touch ID refused. */
const why = (stderr: string) => stderr.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "sops failed";

export const sops: Sops = {
  decrypt: async (file, key, plumbing) => {
    const opened = await spawned(
      ["sops", "decrypt", "--input-type", "yaml", "--output-type", "yaml", file],
      { stdout: "capture", stderr: "capture", stdin: { kind: "none" } },
      keyEnv(key),
      plumbing,
    );
    return opened.code === 0 ? ok(opened.stdout) : err(opened.started ? `cannot open ${file}: ${why(opened.stderr)}` : "sops is not installed (brew install sops)");
  },
  set: async (file, path, value, key) => {
    const index = path.map((segment) => `[${JSON.stringify(segment)}]`).join("");
    // The value on stdin, as JSON: never in an argument a process listing shows.
    const changed = await spawned(
      ["sops", "set", "--idempotent", "--value-stdin", file, index],
      { stdout: "discard", stderr: "capture", stdin: { kind: "given", text: JSON.stringify(value) } },
      keyEnv(key),
    );
    return changed.code === 0 ? ok(undefined) : err(changed.started ? `cannot change ${file}: ${why(changed.stderr)}` : "sops is not installed (brew install sops)");
  },
};
