/* eslint-disable functional/prefer-immutable-types -- owns test lifecycle handles and fake native state */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { oneShotExecution, parseJobExecution } from "../../src/server/deployment/one-shot-execution.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { oneShotJob } from "../../src/server/runtime/one-shot-job.ts";
import { jobRuntime } from "./one-shot-fixture.ts";

type Ports = Parameters<typeof oneShotExecution>[1];
const fixture = async (t: TestContext, change: (ports: Ports) => Ports = (ports) => ports) => {
  const path = await mkdtemp(join(tmpdir(), "kayra-job-test-")); t.after(() => rm(path, { recursive: true, force: true }));
  const lab = jobRuntime(); const journal = await openJournal(path); t.after(() => journal.close());
  const ports: Ports = { native: lab.native, now: lab.clock, read: () => Promise.resolve(lab.plan), authorize: () => Promise.resolve(true), materialize: () => Promise.resolve({ TOKEN: "secret-value" }) };
  const owner = oneShotExecution(journal, change(ports));
  const reopen = async (changed = ports) => {
    await journal.close(); const reopened = await openJournal(path, "existing"); t.after(() => reopened.close()); return oneShotExecution(reopened, changed);
  };
  return { ...lab, path, journal, ports, owner, reopen };
};

test("successful execution retains evidence and a name barrier before reporting completion", async (t) => {
  const lab = await fixture(t); const prepared = await lab.owner.prepare(lab.plan);
  assert.deepEqual(await lab.owner.prepare(lab.plan), prepared);
  await lab.owner.tick(); assert.equal(lab.executions(), 0);
  assert.equal((await lab.owner.tick()).phase, "observing"); assert.equal(lab.executions(), 1);
  const captured = await lab.owner.tick(); assert.equal(captured.phase, "fencing"); assert.equal(captured.evidence?.kind, "succeeded");
  await lab.owner.tick(); const complete = await lab.owner.tick(); assert.equal(complete.phase, "complete");
  assert.ok(complete.container !== complete.barrier); assert.equal(complete.evidence?.exitCode, 0);
  assert.ok(!JSON.stringify(await lab.journal.read()).includes("secret-value"));
  assert.deepEqual(await lab.owner.tick(), complete); assert.equal(lab.executions(), 1);
});

test("restart after persisting Start intent never dispatches it, even while the container is still created", async (t) => {
  const lab = await fixture(t, (ports) => ({ ...ports,
    authorize: (_record, effect) => effect === "start" ? Promise.reject(new Error("simulated process death before dispatch")) : Promise.resolve(true),
  })); const owner = lab.owner;
  await owner.prepare(lab.plan); await owner.tick(); await assert.rejects(owner.tick(), /simulated process death/);
  const restarted = await lab.reopen();
  const captured = await restarted.tick(); assert.equal(captured.phase, "fencing"); assert.equal(captured.evidence?.kind, "unknown");
  await restarted.tick(); assert.equal((await restarted.tick()).phase, "complete"); assert.equal(lab.executions(), 0);
  assert.equal(lab.calls.filter((call) => call.path.endsWith("/start")).length, 0);
});

test("a lost Start acknowledgement is reconstructed from terminal evidence without executing the job twice", async (t) => {
  const lab = await fixture(t, (ports) => ({ ...ports, native: { ...ports.native,
    start: async (...args) => { await ports.native.start(...args); throw new Error("lost acknowledgement"); },
  } })); const owner = lab.owner;
  await owner.prepare(lab.plan); await owner.tick(); await assert.rejects(owner.tick(), /lost acknowledgement/);
  assert.equal(lab.executions(), 1);
  const restarted = await lab.reopen(); assert.equal((await restarted.tick()).evidence?.kind, "succeeded");
  await restarted.tick(); const done = await restarted.tick(); assert.equal(done.phase, "complete"); assert.equal(lab.executions(), 1);
});

test("restart after fencing acknowledgement preserves evidence, identity and the original cleanup deadline", async (t) => {
  const lab = await fixture(t, (ports) => ({ ...ports, native: { ...ports.native,
    fence: async (...args) => { await ports.native.fence(...args); throw new Error("death after fence acknowledgement"); },
  } })); const owner = lab.owner;
  await owner.prepare(lab.plan); await owner.tick(); await owner.tick(); const before = await owner.tick();
  await assert.rejects(owner.tick(), /death after fence/);
  const restarted = await lab.reopen(); const done = await restarted.tick();
  assert.equal(done.phase, "complete"); assert.deepEqual(done.evidence, before.evidence); assert.equal(done.fenceDeadline, before.fenceDeadline);
  assert.equal(lab.executions(), 1);
});

test("running jobs get a persisted bounded fence after expiry; restart does not refresh it", async (t) => {
  const lab = await fixture(t); await lab.owner.prepare(lab.plan); await lab.owner.tick(); await lab.owner.tick(); lab.state("running");
  lab.now(9999); assert.equal((await lab.owner.tick()).phase, "observing");
  lab.now(10_000); const expiring = await lab.owner.tick(); assert.equal(expiring.phase, "fencing"); assert.equal(expiring.evidence?.kind, "unknown");
  assert.equal(expiring.fenceDeadline, 40_000);
  const restarted = await lab.reopen(); lab.now(40_000); const held = await restarted.tick();
  assert.equal(held.phase, "held"); assert.equal(held.fenceDeadline, 40_000);
  assert.equal(lab.calls.filter((call) => call.method === "DELETE").length, 0);
});

test("unsafe evidence and altered immutable plans cannot promote or start a job", async (t) => {
  const lab = await fixture(t); await lab.owner.prepare(lab.plan); await lab.owner.tick(); lab.state("exited");
  assert.equal((await lab.owner.tick()).phase, "held"); assert.equal(lab.executions(), 0);
  const restarted = await lab.reopen({ ...lab.ports, read: () => Promise.resolve({ ...lab.plan, command: ["altered"] }) });
  // Held work remains held; an ordinary retry cannot reauthorize it.
  assert.equal((await restarted.tick()).phase, "held");
  await assert.rejects(restarted.prepare({ ...lab.plan, command: ["altered"] }), /different plan/);
});

test("admission refusal and plan corruption prevent native effects", async (t) => {
  const lab = await fixture(t, (ports) => ({ ...ports, authorize: () => Promise.resolve(false) }));
  const initial = await lab.owner.prepare(lab.plan);
  assert.throws(() => parseJobExecution({ ...initial, secret: "resolved-value" }), /invalid/);
  assert.equal((await lab.owner.tick()).phase, "held"); assert.equal(lab.calls.filter((call) => call.method !== "GET").length, 0);
});

test("a moving plan cannot substitute its command after intent is committed", async (t) => {
  const lab = await fixture(t, (ports) => ({ ...ports, read: async (digest) => {
    const value = await ports.read(digest); assert.ok(value !== null && typeof value === "object"); return { ...value, command: ["altered"] };
  } }));
  await lab.owner.prepare(lab.plan); await assert.rejects(lab.owner.tick(), /integrity/);
  assert.equal(lab.calls.length, 0);
});

test("failed jobs retain their exit evidence without automatic retry", async (t) => {
  const lab = await fixture(t); await lab.owner.prepare(lab.plan); await lab.owner.tick(); await lab.owner.tick(); lab.state("exited", 137);
  const evidence = await lab.owner.tick(); assert.equal(evidence.evidence?.kind, "failed"); assert.equal(evidence.evidence.exitCode, 137);
  await lab.owner.tick(); const complete = await lab.owner.tick(); assert.equal(complete.phase, "complete");
  assert.equal(complete.evidence?.kind, "failed"); assert.equal(lab.executions(), 1);
});

test("a slow runtime observation cannot certify a fence after its persisted deadline", async (t) => {
  const lab = await fixture(t); await lab.owner.prepare(lab.plan); await lab.owner.tick(); await lab.owner.tick();
  const captured = await lab.owner.tick(); await lab.owner.tick(); assert.ok(captured.fenceDeadline !== null);
  const restarted = await lab.reopen({ ...lab.ports, native: { ...lab.native, observe: async (plan) => {
    const value = await lab.native.observe(plan); lab.now(captured.fenceDeadline ?? 0); return value;
  } } });
  assert.equal((await restarted.tick()).phase, "held");
});

test("a duplicate Create arriving during cleanup is fenced without replacing the executed job's evidence", async (t) => {
  const lab = await fixture(t); const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>();
  const delayed = oneShotJob({ request: async (...args: Parameters<typeof lab.api.request>) => {
    if (args[1].startsWith("/containers/create?")) { entered.resolve(undefined); await release.promise; }
    return lab.api.request(...args);
  } }, lab.clock);
  const duplicate = delayed.create(lab.plan, { TOKEN: "secret-value" }); t.after(() => { release.resolve(undefined); }); await entered.promise;
  await lab.owner.prepare(lab.plan); await lab.owner.tick(); await lab.owner.tick(); const captured = await lab.owner.tick();
  const fencer = oneShotJob({ request: async (...args: Parameters<typeof lab.api.request>) => {
    const reply = await lab.api.request(...args);
    if (args[0] === "DELETE") { release.resolve(undefined); await duplicate; }
    return reply;
  } }, lab.clock);
  const restarted = await lab.reopen({ ...lab.ports, native: fencer }); await restarted.tick();
  const late = await lab.native.observe(lab.plan); assert.equal(late.status, "owned"); assert.equal(late.barrier, false); assert.notEqual(late.id, captured.container);
  const fenced = await restarted.tick(); assert.deepEqual(fenced.fenceTargets, [late.id]);
  const done = await restarted.tick(); assert.equal(done.phase, "complete"); assert.deepEqual(done.evidence, captured.evidence);
  assert.equal(done.container, captured.container); assert.equal(lab.executions(), 1);
});
