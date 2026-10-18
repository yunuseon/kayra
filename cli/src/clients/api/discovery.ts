import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { err, ok, type Result } from "../../result.ts";

const entry = z.object({ url: z.string(), token: z.string(), pid: z.number().int().positive() });
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
};

export const discover = (file: string, url: string, token: string): Result<{ readonly remove: () => void }, string> => {
  if (existsSync(file)) {
    if (!lstatSync(file).isFile()) return err(`${file} is not a regular discovery file`);
    try {
      const previous = entry.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!previous.success) return err(`${file} is unreadable; remove it before starting kayra serve`);
      if (alive(previous.data.pid)) return err(`kayra serve is already discoverable for this fleet (pid ${String(previous.data.pid)})`);
      unlinkSync(file);
    } catch { return err(`${file} is unreadable; remove it before starting kayra serve`); }
  }
  const contents = `${JSON.stringify({ url, token, pid: process.pid })}\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents, { mode: 0o600, flag: "wx" });
  return ok({ remove: () => {
    if (existsSync(file) && readFileSync(file, "utf8") === contents) unlinkSync(file);
  } });
};
