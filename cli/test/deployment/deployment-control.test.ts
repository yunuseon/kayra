import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { deploymentControl } from "../../src/server/deployment/deployment-control.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { parseDeploymentReceipt, parseDeploymentRequest } from "../../src/contracts/deployment-request.ts";
import { deployerControlHandler } from "../../src/deployer/deployer.ts";
import { fixture, commit } from "./http-test-fixture.ts";

test("experimental control validates narrow caller input and authority before accepting a durable request", async (t) => {
  const { index, builds, ports } = await fixture(t);
  await index.prepareBuild("shop", commit, builds);
  const input = { app: "shop", commit, request: randomUUID() };
  const enabled = deploymentControl({ index, now: ports.now, plans: ports, canAccess: () => Promise.resolve(true), enabled: () => Promise.resolve(true) });
  const disabled = deploymentControl({ index, now: ports.now, plans: ports, canAccess: () => Promise.resolve(true), enabled: () => Promise.resolve(false) });
  const denied = deploymentControl({ index, now: ports.now, plans: ports, canAccess: () => Promise.resolve(false), enabled: () => Promise.resolve(true) });
  await assert.rejects(disabled("/deployment/prepare", input), /unavailable/);
  await assert.rejects(denied("/deployment/prepare", input), /outside scope/);
  assert.equal(await enabled("/deployment/prepare", { ...input, expected: null }), undefined);
  assert.equal(await enabled("/deployment/prepare", { ...input, environment: { TOKEN: "private" } }), undefined);
  assert.equal(await enabled("/deployment/prepare", { ...input, commit: "main" }), undefined);
  assert.equal(await enabled("/deployment/prepare", { ...input, request: undefined }), undefined);
  assert.equal(await index.httpOperation("shop", input.request), undefined);
  assert.equal(await index.resourceSnapshot(), null);
  assert.equal(await enabled("/deployment/tick", input), undefined);
  const receipt = parseDeploymentReceipt(await enabled("/deployment/prepare", input));
  assert.ok(receipt.ok);
  assert.equal(receipt.value.request, input.request); assert.equal(receipt.value.phase, "prepared");
  assert.equal("ticket" in receipt.value, false); assert.equal("action" in receipt.value, false);
  assert.equal((await index.httpOperation("shop", input.request))?.steps.length, 0);
  assert.deepEqual(await enabled("/deployment/status", { app: "shop" }), await index.deploymentStatus("shop"));
  assert.equal(await enabled("/deployment/status", input), undefined);
});

test("lost request acknowledgement reopens the same receipt without rebuilding a moving plan", async (t) => {
  const { path, index, builds, ports } = await fixture(t); await index.prepareBuild("shop", commit, builds);
  const input = { app: "shop", commit, request: randomUUID() };
  const control = deploymentControl({ index, now: ports.now, plans: ports, canAccess: () => Promise.resolve(true), enabled: () => Promise.resolve(true) });
  const original = await control("/deployment/prepare", input); await index.close();
  const recovered = await openLifecycleAppIndex(path); t.after(() => recovered.close());
  const replay = deploymentControl({ index: recovered, now: ports.now, plans: { ...ports, now: () => 999999, preview: () => { throw new Error("moving inputs must not be read"); } },
    canAccess: () => Promise.resolve(true), enabled: () => Promise.resolve(true) });
  assert.deepEqual(await replay("/deployment/prepare", input), original);
  await assert.rejects(replay("/deployment/prepare", { ...input, commit: "b".repeat(40) }), /conflicting commit/);
  assert.equal(parseDeploymentRequest({ ...input, runtime: "compose" }).ok, false);
});

test("unsupported proposals are refused before workload intent or admission", async (t) => {
  const { index, builds, ports } = await fixture(t); await index.prepareBuild("shop", commit, builds);
  const input = { app: "shop", commit, request: randomUUID() };
  const control = deploymentControl({ index, now: ports.now, plans: { ...ports, preview: async (...args) => ({ ...await ports.preview(...args), unsupported: "feature" }) },
    canAccess: () => Promise.resolve(true), enabled: () => Promise.resolve(true) });
  await assert.rejects(control("/deployment/prepare", input), /invalid immutable/);
  assert.equal(await index.httpOperation("shop", input.request), undefined);
  assert.equal(await index.resourceSnapshot(), null);
});

test("the existing loopback control handler delegates deployment routes and hides private port failures", async (t) => {
  // eslint-disable-next-line functional/no-let -- owns the request trace
  let calls = "";
  const server = createServer(deployerControlHandler({}, (path) => {
    calls += path + "\n";
    return path === "/deployment/status" ? Promise.resolve({ version: 1 }) : Promise.reject(new Error("PRIVATE response"));
  }));
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); }));
  const address = server.address(); assert.ok(address !== null && typeof address !== "string");
  const url = `http://127.0.0.1:${String(address.port)}`;
  const status = await fetch(url + "/deployment/status", { method: "POST", body: '{"app":"shop"}' });
  assert.equal(status.status, 200); assert.deepEqual(await status.json(), { version: 1 });
  const failure = await fetch(url + "/deployment/prepare", { method: "POST", body: '{}' });
  assert.equal(failure.status, 409); assert.equal((await failure.text()).includes("PRIVATE"), false);
  assert.equal(calls, "/deployment/status\n/deployment/prepare\n");
});

test("cancellation is scoped to the recorded request and needs no new plan or resource authority", async (t) => {
  const { index, builds, ports } = await fixture(t); await index.prepareBuild("shop", commit, builds);
  const request = randomUUID(); await index.prepareHttpRollout("shop", request, commit, ports);
  const control = deploymentControl({ index, now: () => 3000, canAccess: () => Promise.resolve(true), enabled: () => Promise.resolve(false) });
  assert.equal(await control("/deployment/cancel", { app: "shop", request, now: 999999 }), undefined);
  assert.equal((await index.httpOperation("shop", request))?.phase, "prepared");
  const denied = deploymentControl({ index, now: () => 3000, canAccess: () => Promise.resolve(false), enabled: () => Promise.resolve(true) });
  await assert.rejects(denied("/deployment/cancel", { app: "shop", request }), /outside deployment scope/);
  const result = parseDeploymentReceipt(await control("/deployment/cancel", { app: "shop", request }));
  assert.ok(result.ok); assert.equal(result.value.phase, "cancelled"); assert.equal(result.value.cancelRequestedAt, 3000);
  assert.deepEqual(await control("/deployment/cancel", { app: "shop", request }), result.value);
  assert.equal(await index.resourceSnapshot(), null);
});
