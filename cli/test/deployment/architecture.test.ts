import { ok } from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: join(import.meta.dirname, "../.."), flags: ["unstable_native_nodejs_ts_config"] });

test("coordinator logic cannot execute raw processes", async () => {
  for (const source of [
    'import "node:child_process";', 'import "child_process";', 'import "node:module";', 'import "module";',
    'import "node:http";', 'import "https";', 'import "node:http2";', 'import "net";',
    'import "node:tls";', 'import "dgram";', 'import "node:dns/promises";', 'import "worker_threads";',
    'import "node:cluster";', 'import "../../deployer/process.ts";', 'import "../runtime/compose.ts";',
    'import "../builder/builder.ts";', 'import "../platform/health.ts";',
  ]) {
    const [result] = await eslint.lintText(source, { filePath: "src/server/deployment/journal.ts" });
    ok(result !== undefined);
    ok(result.messages.some((message) => message.ruleId === "no-restricted-imports"), `not refused: ${source}`);
  }
});

test("coordinator rejects dynamic imports, require and fetch", async () => {
  for (const [source, rule] of [
    ['void import("node:child_process");', "no-restricted-syntax"],
    ['const name = "node:net"; void import(name);', "no-restricted-syntax"],
    ['void require("node:net");', "no-restricted-globals"],
    ['void fetch("http://localhost");', "no-restricted-globals"],
    ['void globalThis.fetch("http://localhost");', "no-restricted-syntax"],
    ['void globalThis["fetch"]("http://localhost");', "no-restricted-syntax"],
    ['void process.getBuiltinModule("node:child_process");', "no-restricted-properties"],
    ['void process["getBuiltinModule"]("node:child_process");', "no-restricted-properties"],
    ['const { getBuiltinModule } = process; void getBuiltinModule("node:child_process");', "no-restricted-properties"],
    ['void process.binding("fs");', "no-restricted-properties"],
    ['void process._linkedBinding("fs");', "no-restricted-properties"],
    ['void process.dlopen;', "no-restricted-properties"],
    ['void process.mainModule;', "no-restricted-properties"],
  ] as const) {
    const [result] = await eslint.lintText(source, { filePath: "src/server/deployment/journal.ts" });
    ok(result !== undefined);
    ok(result.messages.some((message) => message.ruleId === rule), `not refused: ${source}`);
  }
});
