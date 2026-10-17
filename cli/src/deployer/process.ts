import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import type { Argv } from "./compose.ts";
import type { Env, Exit } from "./run.ts";

export type Spawn = {
  readonly cwd?: string;
  readonly env?: Env;
  readonly stdin?: string;
  /** Collect stdout instead of passing it to `line`. */
  readonly capture?: boolean;
  readonly timeoutMs?: number;
};

/** Runs a program; its stderr, and its stdout unless captured, reach `line` one line at a time. */
export const spawnLines = (argv: Argv, options: Spawn, line: (text: string) => void): Promise<Exit> => {
  const [program, ...args] = argv;
  const child = spawn(program, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    signal: AbortSignal.timeout(options.timeoutMs ?? 30 * 60_000),
  });
  // A child may exit before reading its stdin; that EPIPE is no failure of ours.
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.stdin ?? "");
  const stdout = options.capture === true ? text(child.stdout) : Promise.resolve("");
  if (options.capture !== true) createInterface({ input: child.stdout }).on("line", line);
  createInterface({ input: child.stderr }).on("line", line);
  return new Promise((resolve) => {
    child.on("error", (error) => {
      line(error.message);
      resolve({ code: 127, stdout: "" });
    });
    child.on("close", (code) => {
      void stdout.then((captured) => {
        resolve({ code: code ?? 1, stdout: captured });
      });
    });
  });
};
