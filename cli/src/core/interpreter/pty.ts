import type { Argv } from "../plan/model.ts";
import type { Io } from "./io.ts";

/** A step that talks with a person, given a pty: macOS's script, util-linux's elsewhere. */
export const inPty = (argv: Argv, size: Io["size"]): Argv => {
  const { columns, rows } = size ?? { columns: 120, rows: 32 };
  const sized = ["sh", "-c", `stty rows ${String(rows)} cols ${String(columns)} 2>/dev/null; exec "$@"`, "sh", ...argv];
  return process.platform === "darwin"
    // BSD script accepts a pipe, but rejects Node's socket-backed stdin with ENOTSUP.
    ? ["bash", "-c", '"$@" < <(cat); code=$?; kill "$!" 2>/dev/null || :; exit "$code"', "bash", "script", "-q", "/dev/null", ...sized]
    : ["script", "-q", "-e", "-c", sized.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" "), "/dev/null"];
};
