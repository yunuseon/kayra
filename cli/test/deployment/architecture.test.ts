import { ok } from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: join(import.meta.dirname, "../.."), flags: ["unstable_native_nodejs_ts_config"] });

test("coordinator logic cannot execute raw processes", async () => {
  for (const source of ['import "node:child_process";', 'import "../../deployer/process.ts";']) {
    const [result] = await eslint.lintText(source, { filePath: "src/server/deployment/journal.ts" });
    ok(result !== undefined);
    ok(result.messages.some((message) => message.ruleId === "no-restricted-imports"), `not refused: ${source}`);
  }
});
