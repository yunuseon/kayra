import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseMigrationSequencePlan } from "../../src/contracts/migration-sequence.ts";
import { parseJobPlan, parseJobTemplate } from "../../src/contracts/one-shot-job.ts";
import { migrationSequence } from "../../src/server/deployment/migration-sequence.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { sequenceFixture, sequencePlan } from "./migration-sequence-fixture.ts";

const probed = () => {
  const plan = sequencePlan(); return { ...plan, steps: plan.steps.slice(0, 1).map((step) => ({ ...step,
    definition: { ...step.definition, recovery: { kind: "status-probe" as const, command: ["node", "status.mjs"], timeout_seconds: 10 } } })) };
};

test("sequence descriptions reject unsupported commands, forged job authority and timeout grants before intent", () => {
  const plan = sequencePlan(); assert.equal(parseMigrationSequencePlan(plan).ok, true); const first = plan.steps[0]; assert.ok(first);
  assert.equal(parseMigrationSequencePlan({ ...plan, steps: [first, first] }).ok, false);
  assert.equal(parseMigrationSequencePlan({ ...plan, steps: [{ ...first, definition: { ...first.definition, timeout_seconds: 91 } }] }).ok, false);
  assert.equal(parseMigrationSequencePlan({ ...plan, steps: [{ ...first, definition: { ...first.definition, command: ["x".repeat(4097)] } }] }).ok, false);
  assert.equal(parseJobTemplate({ ...first.template, scope: plan.scope }, "shop").ok, false);
  assert.equal(parseJobTemplate({ ...first.template, command: ["forged"] }, "shop").ok, false);
  assert.equal(parseJobTemplate(first.template, "other").ok, false);
});

test("ordered migrations advance only after fenced execution evidence and retain secret references only", async (t) => {
  const lab = await sequenceFixture(t); const prepared = await lab.prepare(); assert.deepEqual(await lab.prepare(), prepared);
  const complete = await lab.drive(); assert.equal(complete.phase, "succeeded"); assert.equal(complete.position, 2);
  assert.deepEqual(complete.steps.map((step) => step.phase), ["applied", "applied"]);
  assert.ok(complete.steps.every((step) => step.attempts[0]?.execution?.barrier !== null));
  assert.equal([...lab.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 2);
  assert.ok(!JSON.stringify(await lab.journal().read()).includes("secret-value"));
});

test("replay-safe failure retries under the same logical operation and original execution deadline", async (t) => {
  const lab = await sequenceFixture(t, sequencePlan(), { afterStart: (plan, runtime) => { if (plan.scope.step === "schema" && plan.scope.attempt === 1) runtime.state("exited", 1); } });
  await lab.prepare(); const done = await lab.drive(); assert.equal(done.phase, "succeeded");
  const attempts = done.steps[0]?.attempts; assert.ok(attempts !== undefined); assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.execution?.executionDeadline, attempts[1]?.execution?.executionDeadline);
  assert.equal(attempts[0]?.execution?.scope.run, attempts[1]?.execution?.scope.run);
  assert.equal(attempts[1]?.execution?.scope.attempt, 2);
});

test("unsafe failure uses the declared probe and advances only on applied", async (t) => {
  const lab = await sequenceFixture(t, probed(), { probe: "applied", afterStart: (plan, runtime) => { if (plan.scope.purpose === "migration") runtime.state("exited", 1); } });
  await lab.prepare(); const done = await lab.drive(); assert.equal(done.phase, "succeeded");
  assert.deepEqual(done.steps[0]?.attempts.map((attempt) => attempt.purpose), ["migration", "probe"]);
  assert.equal(done.steps[0].attempts.at(-1)?.execution?.evidence?.probe, "applied");
});

test("not-applied and unknown probes hold unsafe work instead of silently rerunning it", async (t) => {
  for (const probe of ["not-applied", "unknown"] as const) {
    const lab = await sequenceFixture(t, probed(), { probe, afterStart: (plan, runtime) => { if (plan.scope.purpose === "migration") runtime.state("exited", 1); } });
    await lab.prepare(); const held = await lab.drive(); assert.equal(held.phase, "held"); assert.equal(held.reason, probe === "not-applied" ? "not-applied" : "probe-unknown");
    assert.equal(held.steps[0]?.attempts.filter((attempt) => attempt.purpose === "migration").length, 1);
    assert.deepEqual(await lab.owner().tick(), held);
  }
});

test("a lost Start acknowledgement reconstructs a fenced outcome without duplicate execution", async (t) => {
  const lab = await sequenceFixture(t, sequencePlan(), { afterStart: (plan) => { if (plan.scope.step === "schema") throw new Error("lost start acknowledgement"); } });
  await lab.prepare(); await assert.rejects(lab.drive(), /lost start acknowledgement/);
  const before = await lab.owner().read(); await lab.reopen(); const done = await lab.drive(); assert.equal(done.phase, "succeeded");
  assert.equal(done.steps[0]?.attempts[0]?.execution?.executionDeadline, before?.steps[0]?.attempts[0]?.execution?.executionDeadline);
  assert.equal([...lab.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 2);
});

test("expired sequence intent and admission refusal never create a new unsafe job", async (t) => {
  const expired = await sequenceFixture(t); await expired.prepare(); expired.now(200_000); const held = await expired.owner().tick();
  assert.equal(held.phase, "held"); assert.equal(held.reason, "deadline"); assert.equal(expired.nodes.size, 0);
  const refused = await sequenceFixture(t, sequencePlan(), { admitted: false }); await refused.prepare(); const denied = await refused.drive();
  assert.equal(denied.phase, "held"); assert.equal([...refused.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 0);
});

test("a diagnostic probe has its own persisted deadline after migration execution expires", async (t) => {
  const lab = await sequenceFixture(t, probed(), { probe: "applied", afterStart: (plan, runtime) => { if (plan.scope.purpose === "migration") runtime.state("running"); } });
  await lab.prepare(); const running = await lab.drive((state) => state.steps[0]?.attempts[0]?.execution?.phase === "observing");
  const deadline = running.steps[0]?.executionDeadline; assert.ok(deadline !== undefined && deadline !== null); lab.now(deadline + 1);
  const recovered = await lab.drive(); assert.equal(recovered.phase, "succeeded"); assert.equal(recovered.steps[0]?.executionDeadline, deadline);
  assert.equal(recovered.steps[0].attempts[0]?.execution?.expiry, "execution");
  assert.ok((recovered.steps[0].attempts[1]?.execution?.executionDeadline ?? 0) > deadline);
});

test("safe retries exhaust their bounded attempts without losing the original deadline", async (t) => {
  const lab = await sequenceFixture(t, sequencePlan(), { afterStart: (_plan, runtime) => { runtime.state("exited", 1); } });
  await lab.prepare(); const held = await lab.drive(); assert.equal(held.phase, "held"); assert.equal(held.reason, "attempts-exhausted");
  const attempts = held.steps[0]?.attempts; assert.ok(attempts !== undefined); assert.equal(attempts.length, 8);
  assert.ok(attempts.every((attempt) => attempt.execution?.executionDeadline === held.steps[0]?.executionDeadline));
});

test("interruption before unsafe Start dispatch cannot cause an automatic rerun", async (t) => {
  const lab = await sequenceFixture(t, probed(), { probe: "not-applied", beforeEffect: (effect, job) => {
    if (effect === "start" && job.scope.purpose === "migration") throw new Error("death before unsafe dispatch");
  } });
  await lab.prepare(); await assert.rejects(lab.drive(), /death before unsafe dispatch/); await lab.reopen();
  const held = await lab.drive(); assert.equal(held.phase, "held"); assert.equal(held.reason, "not-applied");
  const migration = [...lab.nodes.values()].find((node) => node.plan.scope.purpose === "migration"); assert.equal(migration?.executions(), 0);
});

test("a valid job artifact with a substituted command still cannot escape the retained sequence description", async (t) => {
  const lab = await sequenceFixture(t); await lab.prepare(); const planned = await lab.owner().tick(); const first = planned.steps[0]?.attempts[0]; assert.ok(first);
  const raw: unknown = JSON.parse(await lab.artifacts.read(first.artifact)); const parsed = parseJobPlan(raw); assert.ok(parsed.ok);
  const changed = await lab.artifacts.retain(JSON.stringify({ ...parsed.value, command: ["node", "other.mjs"] }));
  await lab.journal().write({ ...planned, steps: planned.steps.map((step) => ({ ...step, attempts: step.attempts.map((attempt) => ({ ...attempt, artifact: changed })) })) });
  await assert.rejects(lab.owner().tick(), /description changed/); assert.equal(lab.nodes.size, 0);
});

test("sequence children share one journal owner and refuse a second writer", async (t) => {
  const lab = await sequenceFixture(t); await lab.prepare();
  assert.throws(() => migrationSequence(lab.journal(), lab.ports), /already has/);
  await assert.rejects(openJournal(lab.path, "existing"), /locked|busy/);
});

test("slow artifact reads cannot certify step advancement after the original sequence deadline", async (t) => {
  const lab = await sequenceFixture(t); await lab.prepare();
  const completed = await lab.drive((state) => state.steps[0]?.attempts[0]?.execution?.phase === "complete");
  const artifact = completed.steps[0]?.attempts[0]?.artifact; assert.ok(artifact);
  await lab.reopen({ read: async (digest) => { const bytes = await lab.artifacts.read(digest); if (digest === artifact) lab.now(completed.deadline); return bytes; } });
  const held = await lab.owner().tick(); assert.equal(held.phase, "held"); assert.equal(held.reason, "deadline");
  assert.equal(held.steps[0]?.appliedAt, null); assert.equal(held.completedAt, null); assert.equal(lab.nodes.size, 1);
});
