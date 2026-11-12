import { strict as assert } from "node:assert";
import { test } from "node:test";
import { jobName, jobPlanDigest, parseJobPlan } from "../../src/contracts/one-shot-job.ts";
import { oneShotJob } from "../../src/server/runtime/one-shot-job.ts";
import { jobPlan, jobRuntime } from "./one-shot-fixture.ts";

test("one-shot plans bind image, operation identity and references without recording materialized inputs", () => {
  const plan = jobPlan(); assert.equal(parseJobPlan(plan).ok, true);
  assert.equal(parseJobPlan({ ...plan, image: "nginx:latest" }).ok, false);
  assert.equal(parseJobPlan({ ...plan, environment: { KAYRA_OPERATION_ID: { kind: "literal", value: "forged" } } }).ok, false);
  assert.equal(parseJobPlan({ ...plan, volumes: ["/var/run/docker.sock"] }).ok, false);
  assert.equal(parseJobPlan({ ...plan, scope: { ...plan.scope, purpose: "check" } }).ok, false);
  assert.notEqual(jobName(plan.scope), jobName({ ...plan.scope, purpose: "probe" }));
  assert.notEqual(jobName(plan.scope), jobName({ ...plan.scope, attempt: 2 }));
  assert.notEqual(jobPlanDigest(plan), jobPlanDigest({ ...plan, command: ["other"] }));
  assert.ok(!JSON.stringify(plan).includes("secret-value"));
});

test("a job runs by recorded ID with restart disabled, bounded resources and stable app operation identity", async () => {
  const lab = jobRuntime(); assert.equal(await lab.native.create(lab.plan, { TOKEN: "secret-value" }), "acknowledged");
  const created = await lab.native.observe(lab.plan); assert.equal(created.status, "owned"); assert.equal(created.state, "created");
  const config = lab.calls.find((call) => call.path.startsWith("/containers/create"))?.body;
  assert.ok(config !== null && typeof config === "object" && "HostConfig" in config && "Env" in config);
  assert.ok(JSON.stringify(config.HostConfig).includes('"RestartPolicy":{"Name":"no"'));
  assert.ok(JSON.stringify(config.Env).includes("KAYRA_OPERATION_ID=" + lab.plan.scope.run + ":schema"));
  assert.equal(await lab.native.start(lab.plan, created.id), "acknowledged");
  const done = await lab.native.observe(lab.plan); assert.equal(done.status, "owned"); assert.equal(done.state, "succeeded"); assert.equal(done.exitCode, 0);
  assert.equal(await lab.native.start(lab.plan, created.id), "conflict"); assert.equal(lab.executions(), 1);
  assert.ok(!JSON.stringify(done).includes("secret-value"));
});

test("fencing an uncertain start removes its exact ID and blocks its delayed dispatch", async () => {
  const lab = jobRuntime(); await lab.native.create(lab.plan, { TOKEN: "secret-value" });
  const created = await lab.native.observe(lab.plan); assert.equal(created.status, "owned");
  const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>();
  const old = oneShotJob({ request: async (method, path, body) => {
    if (path.endsWith("/start")) { entered.resolve(undefined); await release.promise; }
    return lab.api.request(method, path, body);
  } }, lab.clock);
  const pending = old.start(lab.plan, created.id); await entered.promise;
  assert.equal(await lab.native.fence(lab.plan, created.id, 15_000), "acknowledged");
  release.resolve(undefined); assert.equal(await pending, "conflict"); assert.equal(lab.executions(), 0);
  const barrier = await lab.native.observe(lab.plan); assert.equal(barrier.status, "owned"); assert.equal(barrier.barrier, true); assert.equal(barrier.state, "created");
  assert.notEqual(barrier.id, created.id); assert.equal(await lab.native.start(lab.plan, barrier.id), "conflict");
  assert.equal(await lab.native.create(lab.plan, { TOKEN: "secret-value" }), "conflict");
  assert.ok(!JSON.stringify(lab.raw()).includes("secret-value"));
});

test("a name barrier prevents a delayed first create after its absent observation", async () => {
  const lab = jobRuntime(); const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>();
  const old = oneShotJob({ request: async (method, path, body) => {
    if (path.startsWith("/containers/create")) { entered.resolve(undefined); await release.promise; }
    return lab.api.request(method, path, body);
  } }, lab.clock);
  const pending = old.create(lab.plan, { TOKEN: "secret-value" }); await entered.promise;
  assert.equal(await lab.native.fence(lab.plan, null, 15_000), "acknowledged"); release.resolve(undefined);
  assert.equal(await pending, "conflict"); assert.equal(lab.executions(), 0);
});

test("foreign identities, expired dispatches and excessive cleanup deadlines cannot authorize a write", async () => {
  const lab = jobRuntime(); await lab.native.create(lab.plan, { TOKEN: "secret-value" });
  assert.equal((await lab.native.observe({ ...lab.plan, command: ["other"] })).status, "foreign");
  assert.equal(await lab.native.fence(lab.plan, "f".repeat(64), 15_000), "conflict");
  lab.now(10_000); assert.equal(await lab.native.start(lab.plan, "1".padStart(64, "0")), "refused");
  assert.equal(await lab.native.create(lab.plan, { TOKEN: "secret-value" }), "refused");
  assert.equal(await lab.native.fence(lab.plan, null, 40_001), "refused");
  assert.equal(lab.executions(), 0);
});

test("a changed restart policy or image-declared volume refuses start before executing application code", async () => {
  const lab = jobRuntime(); await lab.native.create(lab.plan, { TOKEN: "secret-value" });
  const created = await lab.native.observe(lab.plan); assert.equal(created.status, "owned");
  for (const change of ["restart", "volume"]) {
    const altered = oneShotJob({ request: async (method, path, body) => {
      const reply = await lab.api.request(method, path, body);
      if (method !== "GET" || reply.status !== 200) return reply;
      const value = reply.value; assert.ok(value !== null && typeof value === "object" && "Config" in value && "HostConfig" in value);
      assert.ok(value["Config"] !== null && typeof value["Config"] === "object" && value["HostConfig"] !== null && typeof value["HostConfig"] === "object");
      return { ...reply, value: { ...value,
        Config: change === "volume" ? { ...value["Config"], Volumes: { "/data": {} } } : value["Config"],
        HostConfig: change === "restart" ? { ...value["HostConfig"], RestartPolicy: { Name: "always" } } : value["HostConfig"],
      } };
    } }, lab.clock);
    assert.equal(await altered.start(lab.plan, created.id), "refused");
  }
  assert.equal(lab.executions(), 0);
});
