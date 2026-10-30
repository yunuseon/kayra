import { ok } from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: join(import.meta.dirname, "../.."), flags: ["unstable_native_nodejs_ts_config"] });

const refused = async (filePath: string, source: string, rule = "no-restricted-imports") => {
  const [result] = await eslint.lintText(source, { filePath });
  ok(result !== undefined);
  ok(result.messages.some((message) => message.ruleId === rule), `not refused: ${source}`);
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

test("generic library code does not depend on Kayra contracts or server components", async () => {
  await refused("src/lib/typed.ts", 'import type { AppName } from "../contracts/identity.ts";');
  await refused("src/lib/typed.ts", 'import type { Deployed } from "../server/deployment/legacy-restore.ts";');
});


test("operator core consumes public reporting contracts, not deployer internals", async () => {
  await refused("src/core/fleet/settings.ts", 'import "../../deployer/runs/records.ts";');
});


test("runtime adapters do not import policy or coordinator internals", async () => {
  await refused("src/server/runtime/compose.ts", 'import "../platform/maintenance.ts";');
  await refused("src/server/runtime/compose.ts", 'import "../deployment/journal.ts";');
  await refused("src/server/runtime/compose.ts", 'import "../../deployer/runs/run.ts";');
});

test("builder does not depend on workload runtime adapters or legacy Compose operations", async () => {
  await refused("src/server/builder/builder.ts", 'import "../runtime/compose.ts";');
  await refused("src/server/builder/builder.ts", 'import "../../deployer/build/compose.ts";');
  await refused("src/server/builder/builder.ts", 'import "../../deployer/runs/run.ts";');
  await refused("src/server/builder/builder.ts", 'export * from "../../deployer/runs/records.ts";');
});

test("builder cannot bypass static import restrictions with dynamic imports", async () => {
  await refused("src/server/builder/builder.ts", 'void import("../runtime/compose.ts");', "no-restricted-syntax");
  await refused("src/server/builder/builder.ts", 'const path = "../runtime/compose.ts"; void import(path);', "no-restricted-syntax");
});
