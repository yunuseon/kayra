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
  assert.ok(config !== null && typeof config === "object" && "HostConfig" in config && "Env" in config && "Healthcheck" in config);
  assert.deepEqual(config.Healthcheck, { Test: ["NONE"] });
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
  assert.equal(JSON.stringify(lab.raw()).includes('"Healthcheck":{"Test":["NONE"]}'), true);
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

test("changed restart policy, image-declared volumes or inherited health checks refuse start before application code", async () => {
  const lab = jobRuntime(); await lab.native.create(lab.plan, { TOKEN: "secret-value" });
  const created = await lab.native.observe(lab.plan); assert.equal(created.status, "owned");
  for (const change of ["restart", "volume", "healthcheck", "missing-healthcheck"]) {
    const altered = oneShotJob({ request: async (method, path, body) => {
      const reply = await lab.api.request(method, path, body);
      if (method !== "GET" || reply.status !== 200) return reply;
      const value = reply.value; assert.ok(value !== null && typeof value === "object" && "Config" in value && "HostConfig" in value);
      assert.ok(value["Config"] !== null && typeof value["Config"] === "object" && value["HostConfig"] !== null && typeof value["HostConfig"] === "object");
      return { ...reply, value: { ...value,
        Config: change === "volume" ? { ...value["Config"], Volumes: { "/data": {} } } : change === "healthcheck" ? { ...value["Config"], Healthcheck: { Test: ["CMD", "undeclared-command"] } } : change === "missing-healthcheck" ? { ...value["Config"], Healthcheck: null } : value["Config"],
        HostConfig: change === "restart" ? { ...value["HostConfig"], RestartPolicy: { Name: "always" } } : value["HostConfig"],
      } };
    } }, lab.clock);
    assert.equal(await altered.start(lab.plan, created.id), "refused");
  }
  assert.equal(lab.executions(), 0);
});

test("a cold job image is pulled by immutable digest and independently inspected before create", async () => {
  const lab = jobRuntime(); lab.cache(false);
  assert.equal(await lab.native.create(lab.plan, { TOKEN: "secret-value" }), "acknowledged");
  const pull = lab.calls.findIndex((call) => call.path.startsWith("/images/create?"));
  const create = lab.calls.findIndex((call) => call.path.startsWith("/containers/create?"));
  assert.ok(pull >= 0 && create > pull);
  assert.ok(lab.calls.slice(pull + 1, create).some((call) => call.method === "GET" && call.path.startsWith("/images/")));
  assert.ok(lab.calls[pull]?.path.includes("tag=sha256%3A")); assert.equal(lab.executions(), 0);
});

test("successful image-pull HTTP status cannot replace verified image availability", async () => {
  const lab = jobRuntime(); lab.cache(false);
  const native = oneShotJob({ request: async (...args: Readonly<Parameters<typeof lab.api.request>>) => args[1].startsWith("/images/create?")
    ? { status: 200, value: Buffer.from('{"error":"private registry diagnostic"}\n') } : lab.api.request(...args) }, lab.clock);
  assert.equal(await native.create(lab.plan, { TOKEN: "secret-value" }), "uncertain");
  assert.equal(lab.calls.filter((call) => call.path.startsWith("/containers/create?")).length, 0);
  assert.equal(lab.executions(), 0);
});

test("image preparation never extends the job's original dispatch deadline", async () => {
  const lab = jobRuntime(); lab.cache(false);
  const native = oneShotJob({ request: async (...args: Readonly<Parameters<typeof lab.api.request>>) => {
    const result = await lab.api.request(...args); if (args[1].startsWith("/images/create?")) lab.now(lab.plan.deadline); return result;
  } }, lab.clock);
  assert.equal(await native.create(lab.plan, { TOKEN: "secret-value" }), "refused");
  assert.equal(lab.calls.filter((call) => call.path.startsWith("/containers/create?")).length, 0);
});

test("native dispatch respects both recorded start and execution deadlines", async () => {
  const plan = { ...jobPlan(), deadline: 120_000, startDeadline: 90_000, executionTimeoutSeconds: 10 }; const lab = jobRuntime(plan);
  await lab.native.create(plan, { TOKEN: "secret-value" }); const created = await lab.native.observe(plan); assert.equal(created.status, "owned");
  lab.now(60_000); assert.equal(await lab.native.start(plan, created.id, 60_000), "refused");
  lab.now(90_000); assert.equal(await lab.native.start(plan, created.id, 100_000), "refused");
  assert.equal(await lab.native.start(plan, created.id, 120_001), "refused"); assert.equal(lab.executions(), 0);
  assert.equal(parseJobPlan({ ...plan, startDeadline: 120_001 }).ok, false);
});
