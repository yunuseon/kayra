/* The fake runtime owns its evolving observations and dispatch trace. */
/* eslint-disable functional/no-let */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ServiceAction, ServiceObservation, SwarmServicePort } from "../../src/contracts/swarm-service.ts";
import type { RoutedReadinessPort } from "../../src/contracts/routed-readiness.ts";
import { httpExecution } from "../../src/server/deployment/http-execution.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { fixture, commit } from "./http-test-fixture.ts";

const fakeRuntime = () => {
  let current: ServiceObservation = { status: "absent" };
  let writes = 0;
  const native: SwarmServicePort = {
    observe: () => Promise.resolve(current),
    observeDesired: (action) => Promise.resolve(current.status !== "owned" ? current : { ...current, specMatches: current.taskPlan === action.plan && current.tasks.some((task) => task.action === action.action && task.effect === action.effect) }),
    apply: (action, expected, _plan, environment) => {
      assert.equal(environment["TOKEN"], "fixture-private-token");
      assert.equal(expected?.version ?? null, current.status === "owned" ? current.version : null);
      writes += 1;
      current = { status: "owned", id: "s".repeat(25), version: 40 + writes, action: action.action, plan: action.plan, taskPlan: action.plan, effect: action.effect, taskEffect: action.effect,
        specMatches: true, tombstone: false, retainedInputsCleared: false, replicas: 1, endpoint: "vip", update: "completed",
        tasks: [{ id: String(writes).padStart(25, "t"), incarnation: action.incarnation, action: action.action, plan: action.plan, effect: action.effect, state: "running", desired: "running", health: "healthy" }] };
      return Promise.resolve("acknowledged");
    },
    fence: () => { throw new Error("unexpected fence"); }, tombstone: () => { throw new Error("unexpected tombstone"); },
  };
  const readiness: RoutedReadinessPort = { check: (action) => Promise.resolve({ app: action.app, service: action.service, incarnation: action.incarnation, action: action.action, plan: action.plan, checkedAt: 2000, status: "ready" }) };
  return { native, readiness, writes: () => writes, current: () => current, set: (value: ServiceObservation) => { current = value; } };
};

test("dispatch, convergence and routed readiness seal active proof before releasing overlap capacity", async (t) => {
  const { path, index, ports, builds } = await fixture(t);
  await index.prepareBuild("shop", commit, builds);
  const operation = await index.prepareHttpRollout("shop", randomUUID(), commit, ports);
  const runtime = fakeRuntime();
  const executionPorts = { ...ports, ...runtime, now: () => 2000, routing: () => ({}), materialize: () => Promise.resolve({ RELEASE: "A", TOKEN: "fixture-private-token" }) };
  const execution = httpExecution(index, executionPorts);
  assert.equal(await execution.tick("shop", operation.request), "admitted");
  assert.equal(await execution.tick("shop", operation.request), "applying");
  assert.equal(runtime.writes(), 0);
  assert.equal(await execution.tick("shop", operation.request), "verifying");
  assert.equal((await index.httpOperation("shop", operation.request))?.verified, null);
  assert.equal(await execution.tick("shop", operation.request), "succeeded");
  assert.equal(runtime.writes(), 1);
  assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "target");
  const secondCommit = "b".repeat(40);
  await index.prepareBuild("shop", secondCommit, builds);
  const second = await index.prepareHttpRollout("shop", randomUUID(), secondCommit, ports);
  assert.equal(second.previous?.plan, operation.plan);
  await execution.tick("shop", second.request);
  const overlap = await index.resourceSnapshot();
  assert.equal(overlap?.charges[0]?.peak.cpu, 300);
  await execution.tick("shop", second.request); await execution.tick("shop", second.request);
  const candidate = runtime.current(); assert.equal(candidate.status, "owned");
  const candidateTask = candidate.tasks[0]; assert.ok(candidateTask !== undefined);
  runtime.set({ ...candidate, tasks: [...candidate.tasks, { ...candidateTask, id: "old", action: operation.action, plan: operation.plan, state: "running", desired: "shutdown" }] });
  assert.equal(await execution.tick("shop", second.request), "verifying");
  assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "pending");
  assert.equal((await index.httpOperation("shop", second.request))?.verified, null);
  runtime.set(candidate);
  assert.equal(await execution.tick("shop", second.request), "succeeded");
  const sealed = await index.httpOperation("shop", second.request);
  assert.equal(sealed?.verified?.plan, second.plan);
  assert.equal(sealed.deadline, second.deadline);
  await index.close();
  // This is the exact crash window between the app proof and the global settlement write.
  const raw: unknown = JSON.parse(await readFile(join(path, "state.json"), "utf8"));
  assert.ok(typeof raw === "object" && raw !== null);
  await writeFile(join(path, "state.json"), JSON.stringify({ ...raw, resources: overlap }));
  const recovered = await openLifecycleAppIndex(path); t.after(() => recovered.close());
  assert.equal(await httpExecution(recovered, executionPorts).tick("shop", second.request), "succeeded");
  assert.equal((await recovered.resourceSnapshot())?.charges[0]?.result, "target");
  assert.equal(runtime.writes(), 2);
  assert.equal(JSON.stringify(await recovered.httpOperation("shop", second.request)).includes("fixture-private-token"), false);
});

test("a lost observer after update acknowledgement reconstructs success without another write", async (t) => {
  const { path, index, ports, builds } = await fixture(t);
  await index.prepareBuild("shop", commit, builds);
  const operation = await index.prepareHttpRollout("shop", randomUUID(), commit, ports);
  const runtime = fakeRuntime();
  const executionPorts = { ...ports, ...runtime, now: () => 2000, routing: () => ({}), materialize: () => Promise.resolve({ RELEASE: "A", TOKEN: "fixture-private-token" }) };
  const interrupted = httpExecution({ ...index, markHttpDispatched: () => Promise.reject(new Error("observer interrupted after acknowledgement")) }, executionPorts);
  await interrupted.tick("shop", operation.request); await interrupted.tick("shop", operation.request);
  await assert.rejects(interrupted.tick("shop", operation.request), /observer interrupted/);
  assert.equal(runtime.writes(), 1);
  assert.equal((await index.httpOperation("shop", operation.request))?.phase, "applying");
  await index.close();
  const recovered = await openLifecycleAppIndex(path); t.after(() => recovered.close());
  assert.equal(await httpExecution(recovered, executionPorts).tick("shop", operation.request), "succeeded");
  assert.equal(runtime.writes(), 1);
  assert.equal((await recovered.httpOperation("shop", operation.request))?.deadline, operation.deadline);
});

test("failed routed checks, draining tasks and expiry cannot promote an acknowledged candidate", async (t) => {
  const { index, ports, builds } = await fixture(t);
  await index.prepareBuild("shop", commit, builds);
  const operation = await index.prepareHttpRollout("shop", randomUUID(), commit, ports);
  const runtime = fakeRuntime();
  let ready = false;
  const executionPorts = { ...ports, native: runtime.native, now: () => 2000, routing: () => ({}), materialize: () => Promise.resolve({ RELEASE: "A", TOKEN: "fixture-private-token" }),
    readiness: { check: (action: ServiceAction) => Promise.resolve({ app: action.app, service: action.service, incarnation: action.incarnation, action: action.action, plan: action.plan, checkedAt: 2000, status: ready ? "ready" as const : "unready" as const }) } };
  const execution = httpExecution(index, executionPorts);
  await execution.tick("shop", operation.request); await execution.tick("shop", operation.request); await execution.tick("shop", operation.request);
  assert.equal(await execution.tick("shop", operation.request), "verifying");
  assert.equal((await index.httpOperation("shop", operation.request))?.verified, null);
  const current = runtime.current(); assert.equal(current.status, "owned");
  ready = true;
  runtime.set({ ...current, tasks: [...current.tasks, { ...current.tasks[0], id: "old", incarnation: operation.action.split(":")[0] ?? "", action: "old", plan: "c".repeat(64), effect: "apply", desired: "shutdown", state: "running", health: "healthy" }] });
  assert.equal(await execution.tick("shop", operation.request), "verifying");
  runtime.set(current);
  const expired = httpExecution(index, { ...executionPorts, now: () => operation.deadline + 1, materialize: () => { throw new Error("expired candidate inputs must not block recovery"); } });
  assert.equal(await expired.tick("shop", operation.request), "recovering");
  assert.equal((await index.httpOperation("shop", operation.request))?.verified, null);
});
