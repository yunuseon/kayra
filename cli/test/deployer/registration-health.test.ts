import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registrations } from "../../src/deployer/app.ts";
import { assess } from "../../src/server/platform/health.ts";
import { shop } from "./support.ts";

test("invalid registrations fail health without exposing their contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "kayra-registrations-"));
  try {
    const apps = join(dir, "apps");
    mkdirSync(apps);
    writeFileSync(join(apps, "shop.json"), JSON.stringify(shop));
    writeFileSync(join(apps, "bad.json"), JSON.stringify({ ...shop, name: "bad", runtime: "swarm", secret: "PRIVATE-TEST-VALUE" }));
    writeFileSync(join(apps, "broken.json"), '{"secret":"PRIVATE-TEST-VALUE"');
    writeFileSync(join(apps, "ignore.txt"), "not a registration");
    const scanned = registrations(dir);
    deepStrictEqual(scanned.apps.map((app) => app.name), [shop.name]);
    deepStrictEqual([...scanned.invalid].sort(), ["bad", "broken"]);
    const health = assess({ containers: [], apps: [], invalidRegistrations: scanned.invalid, diskUsed: 0.2, memoryAvailable: 0.5 });
    strictEqual(health.healthy, false);
    deepStrictEqual([...health.problems].sort(), ["bad: invalid application registration", "broken: invalid application registration"]);
    strictEqual(JSON.stringify(health).includes("PRIVATE-TEST-VALUE"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
