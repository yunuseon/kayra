/* Owns the fake Engine and interruption gates. */
/* eslint-disable functional/no-let */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { TestContext } from "node:test";
import { test } from "node:test";
import type { ServiceAction, ServiceObservation, SwarmServicePort } from "../../src/contracts/swarm-service.ts";
import { startHttpController } from "../../src/server/composition/http-controller.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { fixture, commit } from "./http-test-fixture.ts";

const runtime = () => {
  let state: ServiceObservation = { status: "absent" }; let writes = 0;
  const native: SwarmServicePort = {
    observe: () => Promise.resolve(state), observeDesired: () => Promise.resolve(state),
    apply: (action) => {
      writes += 1;
      state = { status: "owned", id: "s".repeat(25), version: 42, action: action.action, plan: action.plan, effect: action.effect, taskPlan: action.plan, taskEffect: action.effect,
        specMatches: true, tombstone: false, retainedInputsCleared: false, replicas: 1, endpoint: "vip", update: "completed",
        tasks: [{ id: "t".repeat(25), incarnation: action.incarnation, action: action.action, plan: action.plan, effect: action.effect, desired: "running", state: "running", health: "healthy" }] };
      return Promise.resolve("acknowledged");
    },
    fence: () => { throw new Error("unexpected fence"); }, tombstone: () => { throw new Error("unexpected removal"); },
  };
  return { native, writes: () => writes };
};
// eslint-disable-next-line functional/prefer-immutable-types -- owns test cleanup
const prepared = async (t: TestContext) => {
  const lab = await fixture(t); await lab.index.prepareBuild("shop", commit, lab.builds);
  const operation = await lab.index.prepareHttpRollout("shop", randomUUID(), commit, lab.ports);
  const engine = runtime();
  const ports = { ...lab.ports, ...engine, now: () => 2000, materialize: () => Promise.resolve({ TOKEN: "private-value" }), routing: () => ({}),
    readiness: { check: (action: ServiceAction) => Promise.resolve({ ...action, checkedAt: 2000, status: "ready" as const }) } };
  return { ...lab, operation, engine, ports };
};

test("startup schedules discovered durable work, survives a failed round and stops cleanly", { timeout: 10000 }, async (t) => {
  const lab = await prepared(t); await lab.index.close();
  const reopened = await openLifecycleAppIndex(lab.path); t.after(() => reopened.close());
  let scans = 0; let unavailable = 0;
  let reports = "";
  const completed = Promise.withResolvers<undefined>();
  const controller = startHttpController({ ...reopened, pendingHttpOperations: () => {
    scans += 1;
    return scans === 1 ? Promise.reject(new Error("PRIVATE failed index read")) : reopened.pendingHttpOperations();
  } }, lab.ports, (report) => {
    reports += JSON.stringify(report);
    if (report.status === "unavailable") unavailable += 1;
    if (report.status === "ready" && report.work.some((item) => item.outcome === "succeeded")) completed.resolve(undefined);
  }, 10);
  t.after(() => controller.close());
  await Promise.race([completed.promise, pause(5000).then(() => { throw new Error("controller did not reconstruct work"); })]);
  await controller.close();
  const calls = scans; await pause(30); assert.equal(scans, calls);
  assert.equal(unavailable, 1); assert.equal(reports.includes("PRIVATE"), false);
  assert.equal(lab.engine.writes(), 1);
  assert.equal((await reopened.httpOperation("shop", lab.operation.request))?.phase, "succeeded");
  assert.deepEqual(await reopened.pendingHttpOperations(), []);
  assert.equal((await reopened.resourceSnapshot())?.charges[0]?.result, "target");
});

test("close waits for the in-flight native request and never starts another round", { timeout: 10000 }, async (t) => {
  const lab = await prepared(t);
  const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<"uncertain">();
  let calls = 0; let closed = false;
  const controller = startHttpController(lab.index, { ...lab.ports, native: { ...lab.ports.native, apply: () => {
    calls += 1; entered.resolve(undefined); return release.promise;
  } } }, () => undefined, 10);
  t.after(() => { release.resolve("uncertain"); return controller.close(); });
  await Promise.race([entered.promise, pause(5000).then(() => { throw new Error("native request was not reached"); })]);
  const closing = controller.close().then(() => { closed = true; });
  await pause(20); assert.equal(closed, false);
  release.resolve("uncertain"); await closing;
  await pause(30); assert.equal(calls, 1);
  const operation = await lab.index.httpOperation("shop", lab.operation.request);
  assert.equal(operation?.phase, "verifying"); assert.equal(operation.steps.length, 1);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
});

test("the compatibility composition does not initialize an absent index or enable ordinary rollout control", async (t) => {
  const { startRegistrationControl } = await import("../../src/server/composition/registration.ts");
  const path = await mkdtemp(join(tmpdir(), "kayra-controller-off-")); t.after(() => rm(path, { recursive: true, force: true }));
  const control = await startRegistrationControl({ platformDirectory: path, registrationObservations: join(path, "observations") });
  await assert.rejects(control.handle("/registration/deploy", { app: "shop" }), /not initialized/);
  await control.close(); assert.deepEqual(await readdir(path), []);
});
