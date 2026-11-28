import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseDeploymentHealth } from "../../src/contracts/deployment-health.ts";
import { deploymentControl } from "../../src/server/deployment/deployment-control.ts";
import { recoveryFixture } from "./http-recovery-fixture.ts";
import { fixture } from "./http-test-fixture.ts";

const allow = () => Promise.resolve(true);
test("fresh health ignores failed historical tasks without promoting or rewriting release history", async (t) => {
  const lab = await recoveryFixture(t); const current = lab.current(); assert.equal(current.status, "owned"); const task = current.tasks[0]; assert.ok(task);
  lab.set({ ...current, tasks: [...current.tasks, { ...task, id: "h".repeat(25), plan: "e".repeat(64), action: task.incarnation + ":999", state: "failed", desired: "shutdown", health: "unhealthy" }] });
  const before = await lab.index.deploymentStatus("shop"); const report = await lab.index.deploymentHealth("shop", { ...lab.ports, observe: lab.ports.native.observe });
  assert.equal(report.state, "available"); assert.equal(report.scope, "runtime-services"); assert.deepEqual(report.services.map((service) => [service.currentTasks, service.healthyTasks, service.ignoredHistoricalTasks]), [[1, 1, 1]]);
  assert.equal(report.observedAt, lab.ports.now()); assert.deepEqual(await lab.index.deploymentStatus("shop"), before); assert.equal(before.runtimeObservation, "not-observed"); assert.equal(lab.writes(), 1);
  assert.equal(JSON.stringify(report).includes("private-value"), false); assert.equal(JSON.stringify(report).includes("environment"), false); assert.ok(Object.isFrozen(report.services));
});

test("current failures, missing tasks and unavailable observations never inherit health from a certificate", async (t) => {
  const lab = await recoveryFixture(t); const current = lab.current(); assert.equal(current.status, "owned"); const task = current.tasks[0]; assert.ok(task);
  for (const [observation, expected] of [
    [{ ...current, tasks: [{ ...task, desired: "shutdown", state: "failed", health: "unhealthy" }] }, "missing"],
    [{ ...current, tasks: [{ ...task, state: "failed", health: "unhealthy" }] }, "unhealthy"],
    [{ ...current, tasks: [{ ...task, health: "unknown" }] }, "unavailable"],
    [{ ...current, tasks: [{ ...task, plan: "f".repeat(64) }] }, "mismatch"],
    [{ status: "absent" }, "missing"], [{ status: "foreign" }, "mismatch"], [{ status: "unavailable" }, "unavailable"],
  ] as const) {
    lab.set(observation); assert.equal((await lab.index.deploymentHealth("shop", { ...lab.ports, observe: lab.ports.native.observe })).state, expected);
  }
  assert.equal((await lab.index.deploymentStatus("shop")).verification, "verified"); assert.equal(lab.writes(), 1);
});

test("start-first overlap remains available through old healthy tasks while a candidate starts", async (t) => {
  const lab = await recoveryFixture(t); const previous = lab.current(); assert.equal(previous.status, "owned"); const oldTask = previous.tasks[0]; assert.ok(oldTask);
  const next = await lab.start("b".repeat(40)); lab.delay(true); assert.equal(await lab.execution.tick("shop", next.request), "admitted"); assert.equal(await lab.execution.tick("shop", next.request), "applying");
  const candidate = { ...oldTask, id: "b".repeat(25), plan: next.plan, action: next.action, state: "starting", health: "starting" } as const;
  lab.set({ ...previous, action: next.action, plan: next.plan, taskPlan: next.plan, tasks: [oldTask, candidate] });
  const overlap = await lab.index.deploymentHealth("shop", { ...lab.ports, observe: lab.ports.native.observe }); assert.equal(overlap.state, "available"); assert.equal(overlap.services[0]?.currentTasks, 2); assert.equal(overlap.services[0].healthyTasks, 1);
  lab.set({ ...previous, action: next.action, plan: next.plan, taskPlan: next.plan, tasks: [candidate] }); assert.equal((await lab.index.deploymentHealth("shop", { ...lab.ports, observe: lab.ports.native.observe })).state, "starting");
  lab.set({ ...previous, action: next.action, plan: next.plan, taskPlan: next.plan, tasks: [{ ...candidate, state: "running", health: "healthy" }] });
  assert.equal((await lab.index.deploymentHealth("shop", { ...lab.ports, observe: lab.ports.native.observe })).state, "available"); assert.equal((await lab.index.deploymentStatus("shop")).verifiedActive?.plan, lab.initial.plan);
});

test("verified Swarm registrations without HTTP intent are reported separately and Compose is not guessed", async (t) => {
  const lab = await fixture(t); const ports = { ...lab.ports, observe: () => Promise.reject(new Error("must not observe nonexistent workload intent")) };
  const report = await lab.index.deploymentHealth("shop", ports); assert.equal(report.state, "not-requested"); assert.deepEqual(report.services, []);
  await lab.index.prepareApp("legacy"); const generation = randomUUID(); const ticket = await lab.index.reserveRegistration("legacy", generation);
  await lab.index.submitRegistration("legacy", ticket, generation); await lab.index.reconcileRegistration("legacy", ticket, generation);
  assert.equal((await lab.index.deploymentHealth("legacy", ports)).state, "unsupported");
  const snapshot = await lab.index.runtimeHealthSnapshot(ports); assert.deepEqual(snapshot.map((item) => item.app), ["shop"]);
  await assert.rejects(lab.index.runtimeHealthSnapshot(undefined), /observations are unavailable/);
});

test("health control enforces app scope and immutable plan integrity without runtime mutation", async (t) => {
  const lab = await recoveryFixture(t); const control = deploymentControl({ index: lab.index, observations: { ...lab.ports, observe: lab.ports.native.observe }, canAccess: allow, enabled: () => Promise.resolve(false), now: lab.ports.now });
  const answer = parseDeploymentHealth(await control("/deployment/health", { app: "shop" })); assert.ok(answer.ok); assert.equal(answer.value.state, "available");
  assert.equal(await control("/deployment/health", { app: "shop", runtime: "swarm" }), undefined);
  await assert.rejects(deploymentControl({ index: lab.index, observations: { ...lab.ports, observe: lab.ports.native.observe }, canAccess: () => Promise.resolve(false), enabled: allow, now: lab.ports.now })("/deployment/health", { app: "shop" }), /outside deployment scope/);
  await assert.rejects(lab.index.deploymentHealth("shop", { ...lab.ports, observe: lab.ports.native.observe, read: () => Promise.resolve("{}") }), /integrity/);
  const unavailable = await lab.index.deploymentHealth("shop", { ...lab.ports, observe: () => Promise.reject(new Error("private-runtime-value")) }); assert.equal(unavailable.state, "unavailable"); assert.equal(JSON.stringify(unavailable).includes("private-runtime-value"), false);
  assert.equal(lab.writes(), 1);
});

test("health contract refuses invented availability and accidental exposure of inputs", async (t) => {
  const lab = await recoveryFixture(t); const report = await lab.index.deploymentHealth("shop", { ...lab.ports, observe: lab.ports.native.observe }); const service = report.services[0]; assert.ok(service);
  for (const changed of [{ ...report, environment: { TOKEN: "private" } }, { ...report, state: "unhealthy" }, { ...report, services: [{ ...service, healthyTasks: 0 }] },
    { ...report, services: [{ ...service, currentTasks: null }] }, { ...report, services: [service, service] }, { ...report, runtime: "compose" }]) assert.equal(parseDeploymentHealth(changed).ok, false);
});
