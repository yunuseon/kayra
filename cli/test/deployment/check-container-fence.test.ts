/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types -- models native daemon evidence */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseCheckContainerFence } from "../../src/contracts/check-container-fence.ts";
import { managedServiceName } from "../../src/contracts/managed-service-plan.ts";
import { checkContainerFences } from "../../src/server/runtime/check-container-fence.ts";
import { dockerApi } from "../../src/server/runtime/docker-api.ts";

const fixture = () => {
  const incarnation = randomUUID(); const target = { action: { app: "shop", incarnation, dataOwner: randomUUID(), service: "worker", action: incarnation + ":2", effect: "apply", plan: "a".repeat(64), deadline: 2000 }, service: "s".repeat(25), task: "t".repeat(25), container: "c".repeat(64) };
  const checked = parseCheckContainerFence({ target, barrier: { ...target.action, action: incarnation + ":3:recover:scrub:1", effect: "scrub", plan: "b".repeat(64) }, native: { id: target.service, version: 43 } }); assert.ok(checked.ok); const request = checked.value;
  const ownership = { "com.kayra.app": target.action.app, "com.kayra.incarnation": incarnation, "com.kayra.data-owner": target.action.dataOwner, "com.kayra.service": "worker" };
  const labels = { ...ownership, "com.kayra.action": request.barrier.action, "com.kayra.plan": request.barrier.plan, "com.kayra.effect": "scrub", "com.kayra.tombstone": "true" };
  const spec = { Name: managedServiceName(target.action, "worker"), Labels: labels, Mode: { Replicated: { Replicas: 0 } }, EndpointSpec: { Mode: "dnsrr" }, TaskTemplate: { ContainerSpec: { Labels: labels } } };
  const service = { ID: target.service, Version: { Index: 44 }, Spec: spec, PreviousSpec: spec };
  const container = { Id: target.container, Config: { Labels: { ...ownership, "com.kayra.action": target.action.action, "com.kayra.plan": target.action.plan, "com.kayra.effect": "apply", "com.docker.swarm.service.id": target.service, "com.docker.swarm.task.id": target.task } }, State: { Status: "exited", Running: false, Restarting: false, Paused: false } };
  let actual: unknown = service; let containerReply: { status: number; value: unknown } = { status: 200, value: container }; let unavailable = false;
  const calls: { method: string; path: string }[] = [];
  const api: ReturnType<typeof dockerApi> = { request: (method, path) => {
    calls.push({ method, path }); assert.equal(method, "GET"); if (unavailable) throw new Error("PRIVATE_DAEMON_ERROR");
    return Promise.resolve(path.startsWith("/services/") ? { status: 200, value: actual } : path.startsWith("/tasks?") || path.startsWith("/containers/json?") ? { status: 200, value: [] } : containerReply);
  } };
  return { request, service, spec, container, calls, adapter: checkContainerFences(api, () => 999999), setService: (value: unknown) => { actual = value; }, setContainer: (value: unknown, status = 200) => { containerReply = { value, status }; }, unavailable: () => { unavailable = true; } };
};

test("check cessation requires a scrubbed service barrier and the pinned owned container stopped, even after the original deadline", async () => {
  const f = fixture(); assert.deepEqual(await f.adapter.observe(f.request), { status: "fenced", kind: "stopped", native: { id: f.request.native.id, version: 44 }, checkedAt: 999999 });
  assert.ok(f.calls.every((call) => call.method === "GET")); assert.equal(f.calls.some((call) => call.path.startsWith("/exec/")), false);
});

test("container absence is proof only behind the recorded newer service barrier", async () => {
  const f = fixture(); f.setContainer(null, 404); assert.equal((await f.adapter.observe(f.request)).status, "fenced");
  f.setService({ ...f.service, Version: { Index: 42 } }); assert.equal((await f.adapter.observe(f.request)).status, "foreign");
  f.setService({ ...f.service, Spec: { ...f.spec, Labels: { ...f.spec.Labels, "com.kayra.action": f.request.target.action.action } } }); assert.equal((await f.adapter.observe(f.request)).status, "foreign");
});

test("a metadata fence, nonzero replicas and retained inputs cannot certify a stopped check target", async () => {
  const f = fixture();
  for (const service of [
    { ...f.service, Spec: { ...f.spec, Mode: { Replicated: { Replicas: 1 } } } },
    { ...f.service, Spec: { ...f.spec, TaskTemplate: { ...f.spec.TaskTemplate, Networks: [{ Target: "p".repeat(25) }] } } },
    { ...f.service, PreviousSpec: { ...f.spec, TaskTemplate: { ContainerSpec: { Env: ["PRIVATE=secret"] } } } },
  ]) { f.setService(service); assert.equal((await f.adapter.observe(f.request)).status, "pending"); }
  assert.equal(parseCheckContainerFence({ ...f.request, barrier: { ...f.request.barrier, effect: "fence" } }).ok, false);
});

test("a still-running, restarting or unrecognized container remains pending without coercing absent state fields", async () => {
  const f = fixture();
  for (const state of [{ ...f.container.State, Running: true }, { ...f.container.State, Restarting: true }, { ...f.container.State, Status: "created" }, {}]) {
    f.setContainer({ ...f.container, State: state }); assert.equal((await f.adapter.observe(f.request)).status, "pending");
  }
});

test("foreign container ownership and changed service identity refuse proof, and daemon failures reveal no private error", async () => {
  const f = fixture(); f.setContainer({ ...f.container, Config: { Labels: { ...f.container.Config.Labels, "com.kayra.data-owner": randomUUID() } } }); assert.equal((await f.adapter.observe(f.request)).status, "foreign");
  f.setContainer(f.container); f.setService({ ...f.service, ID: "x".repeat(25) }); assert.equal((await f.adapter.observe(f.request)).status, "foreign");
  f.unavailable(); const result = await f.adapter.observe(f.request); assert.deepEqual(result, { status: "unavailable" }); assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});
