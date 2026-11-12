import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { HttpPlanPort } from "../../src/contracts/http-plan.ts";
import type { BuildPorts } from "../../src/contracts/build-artifact.ts";
import type { HostObserver } from "../../src/contracts/resource-authority.ts";
import { parseApplicationPlan } from "../../src/contracts/application-plan.ts";
import { parseRollout } from "../../src/contracts/rollout.ts";
import { parseSwarmAuthority } from "../../src/contracts/swarm-authority.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";

const host = parseSwarmAuthority(JSON.parse(readFileSync(new URL("../../../ci/tests/swarm-host/authority.json", import.meta.url), "utf8")));
const rollout = parseRollout({ strategy: "rolling", mixed_version_compatible: true, rollback_compatible: true, services: { web: { role: "http", overlap: "allowed" } } });
assert.ok(host.ok && rollout.ok);
const authority = host.value;
// eslint-disable-next-line functional/prefer-immutable-types -- test cleanup context
const fixture = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "kayra-resource-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "index");
  const index = await createLifecycleAppIndex(path, (identity) => Promise.resolve({ ...identity, status: "applied" }));
  t.after(() => index.close());
  const artifacts = await openArtifactStore(join(root, "artifacts"));
  const builds: BuildPorts = { ...artifacts, now: () => 1000, images: () => [], prepare: () => Promise.resolve('{"fixture":"retained"}') };
  const ports: HttpPlanPort & HostObserver & Pick<BuildPorts, "now" | "retain" | "read"> = {
    ...artifacts, now: () => 1000,
    observeHost: () => Promise.resolve({ status: "ready", engine: "29.9.3", api: "1.56", node: authority.node, cluster: authority.cluster, network: authority.network.id,
      capacity: { cpu: authority.profile.cpu_millicores, memory: authority.profile.memory_bytes }, standing: { cpu: authority.profile.platform_cpu_millicores, memory: authority.profile.platform_memory_bytes } }),
    preview: (registration, _runtime, commit, artifact) => Promise.resolve({
      version: 1, runtime: "swarm", app: registration.app, registration, commit, artifact, host: authority,
      grants: { memory_bytes: 1024**3, cpu_millicores: 1000, maintenance: false }, configurationIdentity: "sha256:" + "c".repeat(64), rollout: rollout.value,
      policy: { version: 1, failureMonitorSeconds: 30, updateTimeoutSeconds: 90, rollbackTimeoutSeconds: 90 },
      services: { web: { image: `localhost:5000/${registration.app}/web@sha256:${"d".repeat(64)}`, environment: { GREETING: { kind: "secret", key: "GREETING" } }, command: null, entrypoint: null,
        resources: { memoryBytes: 128 * 1024**2, reserveMemoryBytes: 64 * 1024**2, nanoCpus: 600_000_000, reserveNanoCpus: 100_000_000 },
        health: { command: ["wget", "http://localhost:8080/health"], intervalSeconds: 1, timeoutSeconds: 1, startPeriodSeconds: 1, retries: 3 }, stopGraceSeconds: 30 } },
      routes: [{ host: `${registration.app}.lab.test`, path: null, service: "web", port: 8080, check: "/health", rateLimit: null }],
    }),
  };
  const register = async (app: string) => {
    await index.prepareApp(app);
    const ticket = await index.reserveRegistration(app, "22222222-2222-4222-8222-222222222222", "swarm");
    await index.submitRegistration(app, ticket, "22222222-2222-4222-8222-222222222222");
    await index.reconcileRegistration(app, ticket, "22222222-2222-4222-8222-222222222222");
    await index.prepareBuild(app, "a".repeat(40), builds);
    await index.prepareBuild(app, "b".repeat(40), builds);
  };
  return { root, path, index, ports, register };
};

test("serialized admission retains exact plans, charges overlap once, and survives restart and expiry", async (t) => {
  const { path, index, ports, register } = await fixture(t);
  await register("shop"); await register("other");
  const settled = await Promise.allSettled([index.reserveHttpResources("shop", 2, "a".repeat(40), ports), index.reserveHttpResources("other", 2, "a".repeat(40), ports)]);
  assert.ok(settled.every((item) => item.status === "fulfilled"));
  const first = await index.resourceSnapshot();
  const shop = first?.charges.find((item) => item.app === "shop");
  assert.ok(shop !== undefined);
  const retained = await ports.read(shop.target.plan);
  assert.equal(createHash("sha256").update(retained).digest("hex"), shop.target.plan);
  const parsed = parseApplicationPlan(JSON.parse(retained));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.services["web"]?.environment, { GREETING: { kind: "secret", key: "GREETING" } });
  await index.settleHttpResources("shop", shop.incarnation, 2, "target");
  // 500 standing + 600 active shop + 600 other leaves only 300; overlap needs another 600.
  await assert.rejects(index.reserveHttpResources("shop", 3, "b".repeat(40), ports), /insufficient/);
  const other = first?.charges.find((item) => item.app === "other");
  assert.ok(other !== undefined);
  await index.settleHttpResources("other", other.incarnation, 2, "absent");
  const overlap = await index.reserveHttpResources("shop", 3, "b".repeat(40), ports);
  assert.equal(overlap?.peak.cpu, 1200);
  await index.close();
  const recovered = await openLifecycleAppIndex(path);
  t.after(() => recovered.close());
  assert.deepEqual(await recovered.reserveHttpResources("shop", 3, "b".repeat(40), { ...ports, now: () => 999_999, observeHost: () => Promise.resolve({ status: "unavailable" }) }), overlap);
  await assert.rejects(recovered.reserveHttpResources("other", 3, "b".repeat(40), ports), /insufficient/);
  await assert.rejects(recovered.settleHttpResources("shop", shop.incarnation, 2, "absent"), /does not own/);
  await recovered.settleHttpResources("shop", shop.incarnation, 3, "previous");
  await recovered.reserveHttpResources("other", 3, "b".repeat(40), ports);
});

test("bad retention, changed rolling policy, conflicting retries and unobserved hosts fail before charging", async (t) => {
  const { index, ports, register } = await fixture(t);
  await register("shop");
  await assert.rejects(index.reserveHttpResources("shop", 2, "a".repeat(40), { ...ports, retain: () => Promise.resolve("f".repeat(64)) }), /retention mismatch/);
  await assert.rejects(index.reserveHttpResources("shop", 2, "a".repeat(40), { ...ports, observeHost: () => Promise.resolve({ status: "changed" }) }), /current resource host/);
  await assert.rejects(index.reserveHttpResources("shop", 2, "a".repeat(40), { ...ports, retain: async (content) => { await ports.retain(content); throw new Error("lost plan retention acknowledgement"); } }), /lost plan retention/);
  assert.equal(await index.resourceSnapshot(), null);
  const first = await index.reserveHttpResources("shop", 2, "a".repeat(40), ports);
  assert.ok(first !== undefined);
  await assert.rejects(index.reserveHttpResources("shop", 2, "b".repeat(40), ports), /conflicting intent/);
  await index.settleHttpResources("shop", first.incarnation, 2, "target");
  const changed: HttpPlanPort["preview"] = async (...args) => {
    const plan = await ports.preview(...args);
    return { ...plan, routes: plan.routes.map((route) => ({ ...route, port: 9090 })) };
  };
  await assert.rejects(index.reserveHttpResources("shop", 3, "b".repeat(40), { ...ports, preview: changed }), /unchanged service and routing/);
  assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "target");
});

test("stored plan contracts reject mutation of ownership, resources, effects and secret payloads", async (t) => {
  const { index, ports, register } = await fixture(t);
  await register("shop");
  const policy = await index.registrationPolicy("shop");
  const plan = await ports.preview(policy.metadata, "swarm", "a".repeat(40), "b".repeat(64));
  assert.ok(parseApplicationPlan(plan).ok);
  for (const value of [ { ...plan, app: "other" }, { ...plan, unexpected: true },
    { ...plan, services: { web: { ...plan.services["web"], image: "localhost:5000/shop/../other@sha256:" + "d".repeat(64) } } },
    { ...plan, services: { web: { ...plan.services["web"], environment: { GREETING: { kind: "secret", key: "GREETING", value: "leaked" } } } } },
    { ...plan, policy: { ...plan.policy, updateTimeoutSeconds: 0 } },
  ]) assert.equal(parseApplicationPlan(value).ok, false);
  const parsed = parseApplicationPlan(plan);
  assert.ok(parsed.ok && Object.isFrozen(parsed.value.services["web"]?.environment));
});


test("SIGKILL releases only the writer lock, preserving charged intent and its absolute deadline", { timeout: 10000 }, async (t) => {
  const { root, path, index, ports, register } = await fixture(t);
  await register("shop");
  const registration = await index.verifiedRegistration("shop");
  const receipt = await index.prepareBuild("shop", "a".repeat(40), { ...ports, images: () => [], prepare: () => { throw new Error("already retained"); } });
  const plan = await ports.preview(registration, "swarm", receipt.commit, receipt.artifact);
  const observation = await ports.observeHost(authority);
  await index.close();
  const source = `
    import { openLifecycleAppIndex } from ${JSON.stringify(new URL("../../src/server/deployment/lifecycle-app-index.ts", import.meta.url).href)};
    import { openArtifactStore } from ${JSON.stringify(new URL("../../src/server/deployment/artifact-store.ts", import.meta.url).href)};
    const index = await openLifecycleAppIndex(process.argv[1]);
    const artifacts = await openArtifactStore(process.argv[2]);
    const plan = JSON.parse(process.argv[3]);
    const observation = JSON.parse(process.argv[4]);
    const charge = await index.reserveHttpResources("shop", 2, plan.commit, {
      ...artifacts, now: () => 1000, preview: () => Promise.resolve(plan), observeHost: () => Promise.resolve(observation),
    });
    console.log(JSON.stringify(charge));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, path, join(root, "artifacts"), JSON.stringify(plan), JSON.stringify(observation)], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  try {
    const message: readonly unknown[] = await Promise.race([once(lines, "line", { signal: AbortSignal.timeout(5000) }), exited.then(() => { throw new Error("writer exited before durable admission"); })]);
    const line = message[0];
    assert.ok(typeof line === "string");
    const snapshot: unknown = JSON.parse(line);
    await assert.rejects(openLifecycleAppIndex(path), /locked/);
    child.kill("SIGKILL");
    await exited;
    const recovered = await openLifecycleAppIndex(path);
    try {
      assert.deepEqual(await recovered.reserveHttpResources("shop", 2, receipt.commit, { ...ports, now: () => 1_000_000, observeHost: () => Promise.resolve({ status: "unavailable" }) }), snapshot);
      assert.equal((await recovered.resourceSnapshot())?.charges[0]?.deadline, 91_000);
    } finally { await recovered.close(); }
  } finally { lines.close(); child.kill("SIGKILL"); await exited; }
});
