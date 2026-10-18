import { strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";

const main = join(import.meta.dirname, "..", "src", "main.ts");
const { version } = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")));

test("kayra version and --version print the running kayra's version, outside a fleet too", () => {
  const outside = mkdtempSync(join(tmpdir(), "kayra-version-"));
  try {
    for (const args of [["version"], ["--version"]]) {
      strictEqual(execFileSync("node", [main, ...args], { cwd: outside, encoding: "utf8" }).trim(), version);
    }
  } finally {
    rmSync(outside, { recursive: true });
  }
});
