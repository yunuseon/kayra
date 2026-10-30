import { strictEqual } from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { builderPublicHandler } from "../../src/server/builder/builder.ts";
import { shop } from "./support.ts";

test("public webhooks do not expose invalid registration contents before authentication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kayra-webhook-"));
  const apps = join(dir, "apps");
  mkdirSync(apps);
  writeFileSync(join(apps, "shop.json"), JSON.stringify(shop));
  writeFileSync(join(apps, "broken.json"), '{"private":"PRIVATE-JSON-VALUE"');
  writeFileSync(join(apps, "invalid.json"), JSON.stringify({ ...shop, name: "invalid", ref: "PRIVATE INVALID VALUE" }));
  const server = createServer(builderPublicHandler({ PLATFORM_DIR: dir, WEBHOOK_SECRET: "test-secret" }));
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no TCP listening address");
    const url = `http://127.0.0.1:${String(address.port)}`;
    const payload = JSON.stringify({ ref: "refs/heads/other" });
    const signature = `sha256=${createHmac("sha256", "test-secret").update(payload).digest("hex")}`;
    for (const name of ["broken", "invalid", "missing"]) {
      for (const headers of [{}, { "x-hub-signature-256": signature }]) {
        const response = await fetch(`${url}/hook/${name}`, { method: "POST", body: payload, headers });
        strictEqual(response.status, 404);
        strictEqual(await response.text(), "not found\n");
      }
    }
    const unsigned = await fetch(`${url}/hook/shop`, { method: "POST", body: payload });
    strictEqual(unsigned.status, 401);
    const signed = await fetch(`${url}/hook/shop`, { method: "POST", body: payload, headers: { "x-hub-signature-256": signature } });
    strictEqual(signed.status, 202);
    strictEqual(await signed.text(), "ignored: refs/heads/other (deploys follow main)\n");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error === undefined) resolve(); else reject(error); }));
    rmSync(dir, { recursive: true, force: true });
  }
});
