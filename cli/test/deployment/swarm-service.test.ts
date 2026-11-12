/* Private request traces in tests are intentionally mutable. */
/* eslint-disable functional/prefer-immutable-types, functional/immutable-data */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseApplicationPlan } from "../../src/contracts/application-plan.ts";
import { swarmRouting } from "../../src/server/platform/swarm-routing.ts";
import { renderNativeHttp, swarmService } from "../../src/server/runtime/swarm-service.ts";
import type { dockerApi } from "../../src/server/runtime/docker-api.ts";

const input: unknown = JSON.parse(readFileSync(new URL("../../../ci/tests/swarm-http/native-plan.json", import.meta.url), "utf8"));
const parsed = parseApplicationPlan(input);
assert.ok(parsed.ok);
const plan = parsed.value;
const action = { app: plan.app, service: "web", incarnation: plan.registration.incarnation, action: plan.registration.incarnation + ":2", plan: createHash("sha256").update(JSON.stringify(plan)).digest("hex"), deadline: 91_000 };
const environment = { RELEASE: "A", TOKEN: "PRIVATE-TOKEN" };
const routing = swarmRouting(plan);
const spec = renderNativeHttp(plan, action, environment, routing);
const id = "s".repeat(25);
const service = { ID: id, Version: { Index: 100 }, Spec: spec, UpdateStatus: { State: "completed" } };
const version = { id, version: 42 };

test("native writes use recorded versions once and never infer failure from rejected or interrupted writes", async () => {
  const paths: string[] = [];
  const api: ReturnType<typeof dockerApi> = { request: (method, path, body, options) => {
    paths.push(path);
    if (method === "GET") return Promise.resolve({ status: 200, value: service });
    assert.ok(path.endsWith("/update?version=42"));
    assert.deepEqual(body, spec);
    assert.equal(options?.timeoutMs, 10_000);
    return Promise.resolve({ status: 500, value: { message: "PRIVATE-ERROR" } });
  } };
  const adapter = swarmService(api, () => 1000);
  assert.equal(await adapter.apply(action, version, plan, environment, routing), "uncertain");
  assert.equal(paths.filter((path) => path.includes("/update?")).length, 1);
  const unavailable = swarmService({ request: () => Promise.reject(new Error("PRIVATE-ERROR")) }, () => 1000);
  assert.equal(await unavailable.apply(action, version, plan, environment, routing), "uncertain");
  assert.equal(await unavailable.apply({ ...action, plan: "e".repeat(64) }, version, plan, environment, routing), "refused");
});

test("absolute deadlines stop dispatch after an ownership read and no write targets foreign objects", async () => {
  // eslint-disable-next-line functional/no-let -- advance the clock during a read
  let now = 1000;
  const adapter = swarmService({ request: (method) => { assert.equal(method, "GET"); now = action.deadline; return Promise.resolve({ status: 200, value: service }); } }, () => now);
  assert.equal(await adapter.apply(action, version, plan, environment, routing), "refused");
  const foreign = swarmService({ request: (method) => { assert.equal(method, "GET"); return Promise.resolve({ status: 200, value: { ...service, Spec: { ...spec, Labels: {} } } }); } }, () => 1000);
  assert.equal(await foreign.apply(action, version, plan, environment, routing), "conflict");
  const expired = swarmService({ request: () => { throw new Error("expired intent must not dispatch"); } }, () => 91_001);
  assert.equal(await expired.apply(action, version, plan, environment, routing), "refused");
});

test("observations distinguish top-level plan from rollback task plan and omit raw private Docker fields", async () => {
  const oldLabels = { ...spec.TaskTemplate.ContainerSpec.Labels, "com.kayra.plan": "e".repeat(64) };
  const api: ReturnType<typeof dockerApi> = { request: (_method, path) => Promise.resolve({ status: 200, value: path.startsWith("/services/")
    ? { ...service, Spec: { ...spec, TaskTemplate: { ...spec.TaskTemplate, ContainerSpec: { ...spec.TaskTemplate.ContainerSpec, Labels: oldLabels } } }, UpdateStatus: { State: "rollback_completed", Message: "PRIVATE-ERROR" } }
    : path.startsWith("/tasks?") ? [{ ID: "t".repeat(25), ServiceID: id, DesiredState: "running", Status: { State: "running", Err: "PRIVATE-ERROR", ContainerStatus: { ContainerID: "container" } }, Spec: { ContainerSpec: { Labels: oldLabels, Env: ["PRIVATE-TOKEN"] } } }]
      : { State: { Health: { Status: "healthy", Log: ["PRIVATE-ERROR"] } }, Config: { Env: ["PRIVATE-TOKEN"] } } }) };
  const observation = await swarmService(api).observe({ app: action.app, service: action.service, incarnation: action.incarnation });
  assert.equal(observation.status, "owned");
  assert.equal(observation.plan, action.plan);
  assert.equal(observation.taskPlan, "e".repeat(64));
  assert.equal(observation.tasks[0]?.health, "healthy");
  assert.equal(JSON.stringify(observation).includes("PRIVATE"), false);
});

test("tombstones retain native names without secrets, networks or VIPs; fences leave task templates intact", async () => {
  const writes: unknown[] = [];
  const api: ReturnType<typeof dockerApi> = { request: (method, path, body) => {
    assert.notEqual(method, "DELETE");
    if (method === "GET") return Promise.resolve({ status: 200, value: service });
    assert.ok(path.endsWith("?version=42")); writes.push(body);
    return Promise.resolve({ status: 200, value: null });
  } };
  const adapter = swarmService(api, () => 1000);
  const fence = { ...action, action: action.incarnation + ":3" };
  assert.equal(await adapter.fence(fence, version), "acknowledged");
  assert.deepEqual(writes[0], { ...spec, Labels: { ...spec.Labels, "com.kayra.action": fence.action } });
  assert.equal(await adapter.tombstone(fence, version, plan.services["web"]?.image ?? ""), "acknowledged");
  assert.equal(JSON.stringify(writes[1]).includes("PRIVATE-TOKEN"), false);
  assert.deepEqual(writes[1], { Name: spec.Name, Labels: { ...spec.TaskTemplate.ContainerSpec.Labels, "com.kayra.action": fence.action, "com.kayra.tombstone": "true" },
    TaskTemplate: { ContainerSpec: { Image: spec.TaskTemplate.ContainerSpec.Image, Labels: { ...spec.TaskTemplate.ContainerSpec.Labels, "com.kayra.action": fence.action } }, RestartPolicy: { Condition: "none" }, Networks: [] }, Mode: { Replicated: { Replicas: 0 } }, EndpointSpec: { Mode: "dnsrr" } });
});

test("only a matching plan and exact materialized inputs reach native rendering", () => {
  assert.throws(() => renderNativeHttp(plan, action, { ...environment, EXTRA: "value" }, routing), /materialized/);
  assert.throws(() => renderNativeHttp(plan, action, { ...environment, RELEASE: "B" }, routing), /materialized/);
  assert.throws(() => renderNativeHttp(plan, action, environment, { "com.kayra.app": "other" }), /routing/);
  assert.equal(spec.UpdateConfig.Monitor, 30e9);
  assert.equal(spec.RollbackConfig.Monitor, 30e9);
  assert.equal(spec.EndpointSpec.Mode, "vip");
  assert.equal(spec.Labels["traefik.swarm.lbswarm"], "true");
  assert.ok(Object.keys(spec.Labels).some((key) => key.endsWith(".entrypoints") && spec.Labels[key] === "websecure"));
  assert.equal("Ports" in spec.EndpointSpec, false);
});


test("desired observations verify the actual spec rather than trusting unchanged ownership labels", async () => {
  const matching = swarmService({ request: (_method, path) => Promise.resolve({ status: 200, value: path.startsWith("/services/") ? service : [] }) });
  const verified = await matching.observeDesired(action, plan, environment, routing);
  assert.equal(verified.status, "owned");
  assert.equal(verified.specMatches, true);
  const changed = swarmService({ request: (_method, path) => Promise.resolve({ status: 200, value: path.startsWith("/services/")
    ? { ...service, Spec: { ...spec, TaskTemplate: { ...spec.TaskTemplate, ContainerSpec: { ...spec.TaskTemplate.ContainerSpec, Env: ["TOKEN=another-private-value", "RELEASE=A"] } } } } : [] }) });
  const observation = await changed.observeDesired(action, plan, environment, routing);
  assert.equal(observation.status, "owned");
  assert.equal(observation.specMatches, false);
  assert.equal(JSON.stringify(observation).includes("private-value"), false);
});


test("unexpected native privileges, mounts, published ports and extra routers cannot pass desired verification", async () => {
  for (const changed of [
    { ...spec, Labels: { ...spec.Labels, "traefik.http.routers.other.rule": "Host(`other.test`)" } },
    { ...spec, EndpointSpec: { ...spec.EndpointSpec, Ports: [{ PublishedPort: 8080, TargetPort: 8080 }] } },
    ...[{ Mounts: [{ Source: "/", Target: "/host", Type: "bind" }] }, { User: "root" }, { Args: ["other"] }, { ReadOnly: true }].map((override) => ({ ...spec, TaskTemplate: { ...spec.TaskTemplate, ContainerSpec: { ...spec.TaskTemplate.ContainerSpec, ...override } } })),
  ]) {
    const adapter = swarmService({ request: (_method, path) => Promise.resolve({ status: 200, value: path.startsWith("/services/") ? { ...service, Spec: changed } : [] }) });
    const observation = await adapter.observeDesired(action, plan, environment, routing);
    assert.equal(observation.status, "owned"); assert.equal(observation.specMatches, false);
  }
});
