/* eslint-disable functional/no-let -- drives restart, runtime input loading and observer timers */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { managedIndexFixture } from "./managed-index-fixture.ts";
import { managedIndexRuntimeFixture } from "./managed-index-runtime-fixture.ts";
import { reconcileManagedWork } from "../../src/server/deployment/managed-work.ts";
import { startManagedController } from "../../src/server/composition/managed-controller.ts";
import { parseManagedExecutionContext } from "../../src/contracts/managed-execution-context.ts";
import { managedLifecycleDescription } from "../../src/server/deployment/managed-lifecycle-source.ts";

const ownerPath = (directory: string) => join(directory, createHash("sha256").update("shop").digest("hex"), "managed", "state.json");

test("execution context is authenticated from accepted immutable source without initializing or reading a private root", async (t) => {
  const lab = await managedIndexFixture(t); assert.equal(await lab.index().managedExecutionContext("shop", lab.source.run, lab.runtime), undefined);
  await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime); const path = ownerPath(lab.directory); await rename(path, path + ".held");
  const context = await lab.index().managedExecutionContext("shop", lab.source.run, lab.runtime); assert.ok(context); assert.equal(context.run, lab.source.run); assert.deepEqual(context.application, lab.plan); assert.equal(context.deadline, managedLifecycleDescription(lab.source).deadline); assert.equal(context.allocationRequired, false);
  await assert.rejects(stat(path), { code: "ENOENT" }); assert.equal(parseManagedExecutionContext({ ...context, resolvedSecrets: { hidden: "value" } }).ok, false);
  await assert.rejects(lab.index().managedExecutionContext("shop", lab.source.run, { ...lab.runtime, read: () => Promise.resolve("{}") }), /source unavailable/);
  assert.equal(parseManagedExecutionContext({ ...context, action: "foreign:2" }).ok, false); assert.equal(parseManagedExecutionContext({ ...context, admissionDeadline: context.admissionDeadline + 1 }).ok, false);
});

test("runtime inputs load outside the app writer and one unavailable run does not starve another", async (t) => {
  const lab = await managedIndexFixture(t); await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime); let loaded = 0;
  const ports = { ...lab.runtime, forRun: async (context: NonNullable<Awaited<ReturnType<ReturnType<typeof lab.index>["managedExecutionContext"]>>>) => { const status = await lab.index().managedDeploymentStatus("shop", lab.runtime); assert.equal(status?.operation.run, context.run); loaded++; return lab.runtime; } };
  const result = await reconcileManagedWork(lab.index(), ports); assert.equal(result[0]?.outcome, "admitting"); assert.equal(loaded, 1); assert.equal(lab.hostCalls(), 1);
  const item = { app: "bad", run: lab.source.run }; const mixed = { ...lab.index(), pendingManagedDeployments: () => Promise.resolve([item, { app: "shop", run: lab.source.run }]) };
  const results = await reconcileManagedWork(mixed, ports); assert.equal(results[0]?.outcome, "unavailable"); assert.equal(results[1]?.outcome, "preparing");
});

test("a restarted observer completes an accepted rollout with its original deadlines and no duplicate job Start", async (t) => {
  const lab = await managedIndexRuntimeFixture(t); await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime); const ports = { ...lab.runtime, forRun: () => Promise.resolve(lab.runtime) }; let controller: ReturnType<typeof startManagedController> | undefined;
  t.after(async () => { await controller?.close(); });
  const preparing = Promise.withResolvers<undefined>(); controller = startManagedController(lab.index(), ports, (report) => { if (report.status === "ready" && report.work.some((item) => item.outcome === "preparing")) preparing.resolve(undefined); }, 10);
  await preparing.promise; await controller.close(); await lab.reopen(); const completed = Promise.withResolvers<undefined>();
  controller = startManagedController(lab.index(), ports, (report) => { if (report.status === "ready" && report.work.some((item) => item.outcome === "complete")) completed.resolve(undefined); }, 10);
  const timeout = setTimeout(() => { completed.reject(new Error("managed observer did not converge")); }, 15000);
  try { await completed.promise; } finally { clearTimeout(timeout); await controller.close(); }
  const state = await lab.index().managedState("shop", lab.runtime); assert.equal(state?.operation.phase, "complete"); assert.equal(state.operation.deadline, managedLifecycleDescription(lab.source).deadline);
  assert.deepEqual(await lab.index().pendingManagedDeployments(), []); for (const job of lab.jobs.values()) assert.equal(job.executions(), 1);
  const snapshot = await readFile(ownerPath(lab.directory), "utf8"); assert.equal(await lab.index().managedExecutionContext("shop", lab.source.run, lab.runtime), undefined); assert.equal(await readFile(ownerPath(lab.directory), "utf8"), snapshot);
});

test("a late runtime-input load cannot dispatch after its bounded observer wait expires", async (t) => {
  const lab = await managedIndexFixture(t); await lab.index().requestManagedDeployment("shop", lab.source, lab.runtime); t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = Promise.withResolvers<undefined>(); const runtime = Promise.withResolvers<typeof lab.runtime>();
  const work = reconcileManagedWork(lab.index(), { ...lab.runtime, forRun: () => { entered.resolve(undefined); return runtime.promise; } });
  await entered.promise; t.mock.timers.tick(10_000); assert.equal((await work)[0]?.outcome, "unavailable"); assert.equal(lab.hostCalls(), 0);
  runtime.resolve(lab.runtime); await Promise.resolve(); await Promise.resolve(); assert.equal(lab.hostCalls(), 0);
});
