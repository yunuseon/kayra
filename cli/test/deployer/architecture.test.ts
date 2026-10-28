import { ok } from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: join(import.meta.dirname, "../.."), flags: ["unstable_native_nodejs_ts_config"] });

const refused = async (filePath: string, source: string) => {
  const [result] = await eslint.lintText(source, { filePath });
  ok(result !== undefined);
  ok(result.messages.some((message) => message.ruleId === "no-restricted-imports"), `not refused: ${source}`);
};

test("platform cannot import legacy deployer or coordinator internals", async () => {
  await refused("src/server/platform/cron.ts", 'import "../../deployer/process.ts";');
  await refused("src/server/platform/cron.ts", 'import "../deployment/journal.ts";');
});


test("shared contracts do not depend on component implementations or package-bound schema helpers", async () => {
  await refused("src/contracts/reporting.ts", 'import "../server/deployment/journal.ts";');
  await refused("src/contracts/reporting.ts", 'import "../deployer/process.ts";');
  await refused("src/contracts/reporting.ts", 'import "../lib/schema.ts";');
});


test("operator core consumes public reporting contracts, not deployer internals", async () => {
  await refused("src/core/fleet/settings.ts", 'import "../../deployer/runs/records.ts";');
});


test("runtime adapters do not import policy or coordinator internals", async () => {
  await refused("src/server/runtime/compose.ts", 'import "../platform/maintenance.ts";');
  await refused("src/server/runtime/compose.ts", 'import "../deployment/journal.ts";');
  await refused("src/server/runtime/compose.ts", 'import "../../deployer/runs/run.ts";');
});
