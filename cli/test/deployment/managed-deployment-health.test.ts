/* eslint-disable functional/no-let, functional/immutable-data -- models native health changes independently of immutable deployment state */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { managedIndexRuntimeFixture } from "./managed-index-runtime-fixture.ts";

test("managed health uses current desired tasks, pinned identities and fresh specification observations", async (t) => {
  const lab = await managedIndexRuntimeFixture(t); const { runtime, source } = lab;
  assert.equal(await lab.index().managedDeploymentHealth("shop", runtime), null);
  await lab.index().requestManagedDeployment("shop", source, runtime);
  const empty = await lab.index().managedDeploymentHealth("shop", runtime); assert.equal(empty?.state, "missing");
  for (let count = 0; count < 100; count++) { const state = await lab.index().tickManagedDeployment("shop", source.run, runtime); if (state?.operation.phase === "complete") break; }
  const certified = await lab.index().managedState("shop", runtime); assert.equal(certified?.operation.outcome, "deployed");
  const baseline = await lab.index().managedDeploymentHealth("shop", runtime); assert.equal(baseline?.state, "available");
  const current = lab.services.get("web"); assert.equal(current?.status, "owned"); const task = current.tasks[0]; assert.ok(task);
  lab.services.set("web", { ...current, tasks: [...current.tasks, { ...task, id: "z".repeat(25), desired: "shutdown", state: "failed", health: "unhealthy" }] });
  const historical = await lab.index().managedDeploymentHealth("shop", runtime); assert.equal(historical?.state, "available"); assert.equal(historical.services.find((service) => service.name === "web")?.ignoredHistoricalTasks, 1);
  for (const [change, expected] of [
    [{ update: "paused" }, "unhealthy"], [{ containersConverged: false }, "unavailable"], [{ id: "z".repeat(25) }, "mismatch"],
    [{ tasks: [{ ...task, action: (task.action ?? "") + ":restore:8" }] }, "mismatch"], [{ tasks: [{ ...task, health: "unknown" as const }] }, "unavailable"],
    [{ tasks: [{ ...task, health: "unhealthy" as const }] }, "unhealthy"], [{ tasks: [{ ...task, health: "starting" as const }] }, "starting"],
    [{ tombstone: true }, "missing"],
  ] as const) {
    lab.services.set("web", { ...current, ...change }); const health = await lab.index().managedDeploymentHealth("shop", runtime); assert.equal(health?.services.find((service) => service.name === "web")?.state, expected);
  }
  lab.services.set("web", { status: "foreign" }); assert.equal((await lab.index().managedDeploymentHealth("shop", runtime))?.state, "mismatch");
  lab.services.set("web", current);
  const unavailable = { ...runtime, services: { ...runtime.services, observe: () => Promise.reject(new Error("private native diagnostics")) } };
  assert.equal((await lab.index().managedDeploymentHealth("shop", unavailable))?.state, "unavailable");
  assert.equal((await lab.index().managedDeploymentHealth("shop", { ...runtime, services: { ...runtime.services, observeDesired: () => Promise.resolve({ ...current, specMatches: false }) } }))?.state, "mismatch");
  assert.deepEqual(await lab.index().runtimeHealthSnapshot(undefined, runtime), [baseline]);
  await lab.reopen(); assert.equal((await lab.index().managedDeploymentHealth("shop", runtime))?.state, "available"); assert.deepEqual(await lab.index().managedState("shop", runtime), certified);
});
