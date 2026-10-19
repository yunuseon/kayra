import { capture } from "../interpreter/process.ts";
import { err, ok } from "../../result.ts";
import type { Tofu } from "../status/ports.ts";

/** Why tofu could not read the state, in a few words: the first line of its error. */
export const unreadable = (stderr: string): string => {
  if (stderr.includes("tofu init")) return "tofu init needed";
  const line = stderr
    .split("\n")
    .map((each) => each.replace(/^[│╷╵\s]+/, "").replace(/^Error:\s*/, "").trim())
    .find((each) => each !== "");
  return line ?? "tofu failed";
};

/** OpenTofu, read and never changed. */
export const opentofu: Tofu = {
  state: async (dir) => {
    const listed = await capture(["tofu", `-chdir=${dir}`, "state", "list", "-no-color"], "capture");
    return listed.code === 0 ? ok(listed.stdout.split("\n").filter((line) => line.trim() !== "")) : err(unreadable(listed.stderr));
  },
  output: async (dir, name) => {
    const value = await capture(["tofu", `-chdir=${dir}`, "output", "-raw", name], "capture");
    const text = value.stdout.trim();
    return value.code === 0 && text !== "" ? text : undefined;
  },
};
