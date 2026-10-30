import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registrations } from "../../src/deployer/app.ts";
import { deployerPushHandler } from "../../src/deployer/deployer.ts";
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

test("HTTP health reports invalid registrations without exposing their contents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kayra-health-http-"));
  const apps = join(dir, "apps");
  mkdirSync(apps);
  writeFileSync(join(apps, "shop.json"), JSON.stringify(shop));
  const server = createServer(deployerPushHandler({ PLATFORM_DIR: dir }, (observedApps, disk) => {
    deepStrictEqual(observedApps, [{ name: "shop", released: false }]);
    strictEqual(disk, join(dir, "runs"));
    return Promise.resolve({ apps: observedApps, containers: [], diskUsed: 0.2, memoryAvailable: 0.5 });
  }));
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no TCP listening address");
    const url = `http://127.0.0.1:${String(address.port)}/health`;
    const before = await fetch(url);
    strictEqual(before.status, 200);
    deepStrictEqual(await before.json(), { healthy: true, problems: [], warnings: [] });
    writeFileSync(join(apps, "broken.json"), '{"secret":"PRIVATE-TEST-VALUE"');
    const response = await fetch(url);
    strictEqual(response.status, 503);
    const body = await response.text();
    strictEqual(body.includes("PRIVATE-TEST-VALUE"), false);
    deepStrictEqual(JSON.parse(body), { healthy: false, problems: ["broken: invalid application registration"], warnings: [] });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error === undefined) resolve(); else reject(error); }));
    rmSync(dir, { recursive: true, force: true });
  }
});
