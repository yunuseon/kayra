import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { parseJobCleanupPlan } from "../../src/contracts/job-cleanup.ts";
import { jobPlanDigest } from "../../src/contracts/one-shot-job.ts";
import { jobCleanup } from "../../src/server/deployment/job-cleanup.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { oneShotCleanup, oneShotJob } from "../../src/server/runtime/one-shot-job.ts";
import { jobRuntime } from "./one-shot-fixture.ts";

// eslint-disable-next-line functional/prefer-immutable-types -- TestContext owns test cleanup callbacks
const fixture = async (t: TestContext) => {
  const path = await mkdtemp(join(tmpdir(), "kayra-cleanup-test-")); t.after(() => rm(path, { recursive: true, force: true }));
  const journal = await openJournal(path); t.after(() => journal.close());
  const lab = jobRuntime(); await lab.native.create(lab.plan, { TOKEN: "secret-value" }); lab.now(100_000);
  const authority = { version: 1 as const, action: randomUUID(), job: jobPlanDigest(lab.plan), createdAt: 100_000, deadline: 130_000 };
  const ports = { native: oneShotCleanup(lab.api, lab.clock), now: lab.clock, read: () => Promise.resolve(JSON.stringify(lab.plan)), authorize: () => Promise.resolve(true) };
  return { ...lab, path, journal, authority, ports };
};

test("explicit cleanup has separate bounded authority and no application Create or Start interface", async (t) => {
  const lab = await fixture(t); const before = await lab.native.observe(lab.plan); assert.equal(before.status, "owned");
  assert.deepEqual(Object.keys(lab.ports.native).toSorted(), ["fence", "observe"]);
  assert.equal(await lab.native.fence(lab.plan, before.id, lab.authority.deadline), "refused");
  assert.equal(await lab.native.start(lab.plan, before.id), "refused");
  const owner = jobCleanup(lab.journal, lab.ports); await owner.prepare(lab.authority);
  const recorded = await owner.tick(); assert.deepEqual(recorded.targets, [before.id]); assert.equal(recorded.phase, "fencing");
  const complete = await owner.tick(); assert.equal(complete.phase, "complete"); assert.notEqual(complete.barrier, before.id);
  assert.equal(lab.executions(), 0); assert.equal(lab.plan.deadline, 10_000);
  assert.equal(JSON.stringify(lab.raw()).includes("secret-value"), false);
  assert.equal(JSON.stringify(complete).includes("secret-value"), false);
  const calls = lab.calls.length; assert.deepEqual(await owner.tick(), complete); assert.equal(lab.calls.length, calls);
});

test("restart after cleanup acknowledgement observes the existing barrier without repeating a command or deletion", async (t) => {
  const lab = await fixture(t); const original = jobCleanup(lab.journal, { ...lab.ports, native: { ...lab.ports.native, fence: async (...args) => {
    await lab.ports.native.fence(...args); throw new Error("lost cleanup acknowledgement");
  } } }); await original.prepare(lab.authority);
  await assert.rejects(original.tick(), /lost cleanup acknowledgement/); await lab.journal.close();
  const journal = await openJournal(lab.path, "existing"); t.after(() => journal.close()); const recovered = jobCleanup(journal, lab.ports);
  const writes = lab.calls.filter((call) => call.method !== "GET").length;
  assert.equal((await recovered.tick()).phase, "complete"); assert.equal(lab.calls.filter((call) => call.method !== "GET").length, writes);
  assert.equal(lab.executions(), 0); assert.equal((await recovered.read())?.authority.deadline, 130_000);
  await assert.rejects(recovered.prepare({ ...lab.authority, createdAt: 200_000, deadline: 230_000 }), /authority changed/);
});

test("expiration survives restart and cannot be extended by the cleanup adapter", async (t) => {
  const lab = await fixture(t); const owner = jobCleanup(lab.journal, lab.ports); await owner.prepare(lab.authority); await lab.journal.close(); lab.now(130_000);
  const journal = await openJournal(lab.path, "existing"); t.after(() => journal.close()); const recovered = jobCleanup(journal, lab.ports);
  const calls = lab.calls.length; assert.equal((await recovered.tick()).phase, "held"); assert.equal(lab.calls.length, calls);
  assert.equal(await lab.ports.native.fence(lab.plan, lab.authority, null), "refused");
  assert.equal(parseJobCleanupPlan({ ...lab.authority, deadline: 130_001 }).ok, false);
  assert.equal(parseJobCleanupPlan({ ...lab.authority, command: ["other"] }).ok, false);
  assert.equal(await lab.ports.native.fence(lab.plan, { ...lab.authority, job: "f".repeat(64) }, null), "refused");
  assert.equal((await lab.native.observe(lab.plan)).status, "owned");
});

test("foreign observations, denied ownership and slow inspection cannot authorize cleanup effects", async (t) => {
  for (const fault of ["foreign", "wrong-plan", "denied", "late"] as const) {
    const lab = await fixture(t); const native = { ...lab.ports.native, observe: async (...args: Readonly<Parameters<typeof lab.ports.native.observe>>) => {
      const observed = await lab.ports.native.observe(...args);
      if (fault === "late") lab.now(130_000);
      if (fault === "foreign") return { status: "foreign" as const };
      return fault === "wrong-plan" && observed.status === "owned" ? { ...observed, plan: "f".repeat(64) } : observed;
    } };
    const owner = jobCleanup(lab.journal, { ...lab.ports, native, authorize: () => Promise.resolve(fault !== "denied") }); await owner.prepare(lab.authority);
    const writes = lab.calls.filter((call) => call.method !== "GET").length;
    assert.equal((await owner.tick()).phase, "held"); assert.equal(lab.calls.filter((call) => call.method !== "GET").length, writes);
    assert.equal(lab.executions(), 0);
  }
});

test("a slow native inspect cannot dispatch cleanup DELETE after its absolute deadline", async (t) => {
  const lab = await fixture(t); const container = await lab.native.observe(lab.plan); assert.equal(container.status, "owned");
  const api = { request: async (...args: Readonly<Parameters<typeof lab.api.request>>) => {
    const response = await lab.api.request(...args);
    if (args[0] === "GET") lab.now(130_000);
    return response;
  } };
  const cleanup = oneShotCleanup(api, lab.clock); assert.equal(await cleanup.fence(lab.plan, lab.authority, container.id), "refused");
  assert.equal(lab.calls.filter((call) => call.method === "DELETE").length, 0);
});

test("Start rechecks the original deadline after inspecting a prepared container", async () => {
  const lab = jobRuntime(); await lab.native.create(lab.plan, { TOKEN: "secret-value" });
  const observed = await lab.native.observe(lab.plan); assert.equal(observed.status, "owned");
  const native = oneShotJob({ request: async (...args: Readonly<Parameters<typeof lab.api.request>>) => {
    const response = await lab.api.request(...args); if (args[0] === "GET") lab.now(lab.plan.deadline); return response;
  } }, lab.clock);
  assert.equal(await native.start(lab.plan, observed.id), "refused"); assert.equal(lab.executions(), 0);
});
