/* eslint-disable functional/immutable-data, functional/prefer-immutable-types, functional/no-let -- local TLS request evidence and response fixtures */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { managedServiceDigest, managedServiceName } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedServiceAction } from "../../src/contracts/managed-swarm-service.ts";
import { managedRoutedReadiness } from "../../src/server/platform/managed-routed-readiness.ts";

test("managed readiness verifies every route of its service with trusted TLS and no retries", { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kayra-managed-routing-tls-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const certificate = join(directory, "certificate.pem"); const key = join(directory, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=www.lab.test", "-addext", "subjectAltName=DNS:www.lab.test,DNS:api.lab.test", "-keyout", key, "-out", certificate], { stdio: "ignore" });
  const ca = await readFile(certificate, "utf8"); let failed = false;
  const requests: { readonly host: string | undefined; readonly path: string | undefined; readonly port: number | undefined }[] = [];
  const server = createServer({ cert: ca, key: await readFile(key) }, (request, response) => {
    requests.push({ host: request.headers.host, path: request.url, port: request.socket.remotePort });
    response.statusCode = failed && request.url === "/two" ? 503 : 200; response.end("not buffered by readiness");
  }).listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(); })));
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  const { plan } = await managedPlanFixture(); const web = plan.services["web"]; const route = plan.routes[0]; assert.ok(web && route);
  const checked = parseManagedApplicationPlan({ ...plan, hosts: [...plan.hosts, "api.lab.test"],
    services: { ...plan.services, api: { ...web, service: "api", nativeName: managedServiceName(web.owner, "api") } },
    rollout: { ...plan.rollout, services: { ...plan.rollout.services, api: { role: "http", overlap: "allowed" } } },
    routes: [{ ...route, path: "/one", check: "/one" }, { ...route, path: "/two", check: "/two" }, { ...route, host: "api.lab.test", service: "api", check: "/api" }],
  }); assert.ok(checked.ok); const managed = checked.value;
  const action: ManagedServiceAction = { app: web.owner.app, service: "web", incarnation: web.owner.incarnation, dataOwner: web.owner.dataOwner,
    action: web.owner.incarnation + ":2", plan: managedServiceDigest(web), deadline: 91000, effect: "apply" };
  const client = managedRoutedReadiness({ address: "127.0.0.1", port: address.port, ca, now: () => 2000 });
  const healthy = await client.check(action, managed); assert.equal(healthy.status, "ready"); assert.equal(healthy.checkedAt, 2000);
  assert.equal(requests.length, 2); assert.deepEqual(new Set(requests.map((value) => value.path)), new Set(["/one", "/two"]));
  assert.ok(requests.every((value) => value.host === "www.lab.test")); assert.equal(new Set(requests.map((value) => value.port)).size, 2);
  failed = true; assert.equal((await client.check(action, managed)).status, "unready"); assert.equal(requests.length, 4);
  for (const bad of [{ ...action, plan: "f".repeat(64) }, { ...action, dataOwner: randomUUID() }, { ...action, service: "worker" }]) assert.equal((await client.check(bad, managed)).status, "unavailable");
  assert.equal(requests.length, 4);
  const untrusted = managedRoutedReadiness({ address: "127.0.0.1", port: address.port }); assert.equal((await untrusted.check(action, managed)).status, "unavailable"); assert.equal(requests.length, 4);
  const api = managed.services["api"]; assert.ok(api);
  assert.equal((await client.check({ ...action, service: "api", plan: managedServiceDigest(api) }, managed)).status, "ready"); assert.equal(requests.length, 5); assert.equal(requests.at(-1)?.host, "api.lab.test");
});
