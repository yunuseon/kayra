/* Local HTTP request traces are mutable test evidence. */
/* eslint-disable functional/immutable-data, functional/prefer-immutable-types */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseApplicationPlan } from "../../src/contracts/application-plan.ts";
import type { ServiceAction } from "../../src/contracts/swarm-service.ts";
import { routedReadiness } from "../../src/server/platform/routed-readiness.ts";

const parsed = parseApplicationPlan(JSON.parse(readFileSync(new URL("../../../ci/tests/swarm-http/native-plan.json", import.meta.url), "utf8")));
assert.ok(parsed.ok);
const base = parsed.value;

test("routed readiness verifies TLS/SNI, uses fresh connections and does not follow redirects or retry failures", { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kayra-readiness-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certificate = join(directory, "certificate.pem");
  const key = join(directory, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=native.lab.test", "-addext", "subjectAltName=DNS:native.lab.test", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const ca = await readFile(certificate, "utf8");
  const requests: { readonly host: string | undefined; readonly path: string | undefined; readonly port: number | undefined }[] = [];
  const server = createServer({ cert: ca, key: await readFile(key) }, (request, response) => {
    requests.push({ host: request.headers.host, path: request.url, port: request.socket.remotePort });
    if (request.url === "/slow") return;
    response.statusCode = request.url === "/bad" ? 503 : request.url === "/redirect" ? 302 : 200;
    response.setHeader("Location", "https://external.invalid/"); response.end("readiness");
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(); })));
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  const client = routedReadiness({ address: "127.0.0.1", port: address.port, ca, now: () => 2000 });
  const check = (path: string) => {
    const plan = { ...base, routes: base.routes.map((route) => ({ ...route, check: path })) };
    const checked = parseApplicationPlan(plan); assert.ok(checked.ok);
    const action: ServiceAction = { app: plan.app, service: "web", incarnation: plan.registration.incarnation, action: plan.registration.incarnation + ":2", plan: createHash("sha256").update(JSON.stringify(checked.value)).digest("hex"), effect: "apply", deadline: 91_000 };
    return { plan: checked.value, action };
  };
  const healthy = check("/health");
  assert.equal((await client.check(healthy.action, healthy.plan)).status, "ready");
  assert.equal((await client.check(healthy.action, healthy.plan)).status, "ready");
  assert.equal(requests[0]?.host, "native.lab.test"); assert.equal(requests[0].path, "/health");
  assert.notEqual(requests[0].port, requests[1]?.port);
  const redirect = check("/redirect");
  assert.equal((await client.check(redirect.action, redirect.plan)).status, "ready");
  assert.equal(requests.length, 3);
  const bad = check("/bad");
  assert.equal((await client.check(bad.action, bad.plan)).status, "unready");
  assert.equal(requests.length, 4);
  assert.equal((await client.check({ ...healthy.action, plan: "f".repeat(64) }, healthy.plan)).status, "unavailable");
  assert.equal(requests.length, 4);
  const untrusted = routedReadiness({ address: "127.0.0.1", port: address.port, now: () => 2000 });
  assert.equal((await untrusted.check(healthy.action, healthy.plan)).status, "unavailable");
  assert.equal(requests.length, 4);
  const slow = check("/slow");
  assert.equal((await routedReadiness({ address: "127.0.0.1", port: address.port, ca, timeoutMs: 50 }).check(slow.action, slow.plan)).status, "unavailable");
  assert.equal(requests.length, 5);
  const privatePem = await readFile(key, "utf8");
  assert.throws(() => routedReadiness({ ca: ca + privatePem }), /invalid platform/);
});
