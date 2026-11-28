import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseMigrationResolutionRequest } from "../../src/contracts/migration-resolution.ts";
import { parseMigrationSequenceState } from "../../src/server/deployment/migration-sequence.ts";
import { migrationResolutionId } from "../../src/server/deployment/migration-resolution-audit.ts";
import { resolveMigrationSequence } from "../../src/server/deployment/migration-resolution.ts";
import { sequenceFixture, sequencePlan } from "./migration-sequence-fixture.ts";

const actor = { kind: "operator-control" as const, identity: "lab-operator" };
const plan = (multiple = false) => {
  const source = sequencePlan(); return { ...source, steps: source.steps.slice(0, multiple ? 2 : 1).map((step, index) => index === 0 ? { ...step,
    definition: { ...step.definition, recovery: { kind: "status-probe" as const, command: ["node", "status.mjs"], timeout_seconds: 10 } } } : step) };
};
const statement = (run: string, outcome: "applied" | "not-applied" = "applied") => ({ app: "shop", run, step: "schema", outcome, reason: "Operator checked the application migration ledger" });

test("operator request validation cannot supply actor, deadlines, commands or private inputs", () => {
  const input = statement(sequencePlan().scope.run); assert.ok(parseMigrationResolutionRequest(input).ok);
  for (const extra of [{ actor }, { deadline: 1 }, { command: ["other"] }, { environment: {} }, { outcome: "unknown" }, { reason: "\u001b[31munsafe" }]) assert.equal(parseMigrationResolutionRequest({ ...input, ...extra }).ok, false);
});

test("applied resolution preserves unknown runtime evidence and advances only after every owned fence is observed", async (t) => {
  const lab = await sequenceFixture(t, plan(), { probe: "unknown", afterStart: (job, runtime) => { if (job.scope.purpose === "migration") runtime.state("exited", 1); } });
  await lab.prepare(); const held = await lab.drive(); const before = JSON.stringify(held.steps[0]?.attempts);
  const result = await resolveMigrationSequence(held, lab.plan, statement(held.scope.run), actor, lab.ports);
  assert.equal(result.disposition, "continue"); assert.equal(result.state.phase, "succeeded");
  assert.equal(JSON.stringify(result.state.steps[0]?.attempts), before); assert.equal(result.state.steps[0]?.attempts.at(-1)?.execution?.evidence?.probe, "unknown");
  assert.equal(result.audit.id, migrationResolutionId(held.plan, { ...held.scope, step: "schema" }));
  assert.equal(result.state.deadline, held.deadline); assert.equal((await lab.owner().read())?.phase, "held");
  assert.equal([...lab.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 2);
});

test("persisting a resolution lets the phase resume the next step without replaying the unsafe migration", async (t) => {
  const lab = await sequenceFixture(t, plan(true), { probe: "unknown", afterStart: (job, runtime) => { if (job.scope.step === "schema" && job.scope.purpose === "migration") runtime.state("exited", 1); } });
  await lab.prepare(); const held = await lab.drive(); const resolved = await resolveMigrationSequence(held, lab.plan, statement(held.scope.run), actor, lab.ports);
  assert.equal(resolved.state.phase, "running"); assert.equal(resolved.state.position, 1); await lab.journal().write(resolved.state); await lab.reopen();
  const done = await lab.drive(); assert.equal(done.phase, "succeeded"); assert.equal(done.steps[0]?.attempts.filter((attempt) => attempt.purpose === "migration").length, 1);
  const replay = await resolveMigrationSequence(done, lab.plan, statement(held.scope.run), actor, { ...lab.ports, now: () => done.deadline + 1000,
    native: { observe: () => { throw new Error("an existing resolution must not repeat runtime observations"); } } });
  assert.deepEqual(replay.audit, resolved.audit); assert.deepEqual(replay.state, done);
  await assert.rejects(resolveMigrationSequence(done, lab.plan, statement(held.scope.run, "not-applied"), actor, lab.ports), /already resolved differently/);
});

test("not-applied resolution retains a failed disposition and never retries unsafe work", async (t) => {
  const lab = await sequenceFixture(t, plan(), { probe: "unknown", afterStart: (job, runtime) => { if (job.scope.purpose === "migration") runtime.state("exited", 1); } });
  await lab.prepare(); const held = await lab.drive(); const result = await resolveMigrationSequence(held, lab.plan, statement(held.scope.run, "not-applied"), actor, lab.ports);
  assert.equal(result.disposition, "failed"); assert.equal(result.state.phase, "held"); assert.equal(result.state.reason, "not-applied");
  assert.equal(result.state.position, 0); assert.equal(result.state.steps[0]?.appliedAt, null); assert.equal(result.state.deadline, held.deadline);
  assert.equal(result.state.steps[0].attempts.length, held.steps[0]?.attempts.length);
});

test("late assertions are audited without inventing timely completion or another execution window", async (t) => {
  const lab = await sequenceFixture(t, plan(), { probe: "unknown", afterStart: (job, runtime) => { if (job.scope.purpose === "migration") runtime.state("exited", 1); } });
  await lab.prepare(); const held = await lab.drive(); lab.now(held.deadline + 1);
  const result = await resolveMigrationSequence(held, lab.plan, statement(held.scope.run), actor, lab.ports);
  assert.equal(result.disposition, "failed"); assert.equal(result.state.phase, "held"); assert.equal(result.state.reason, "deadline");
  assert.equal(result.audit.at, held.deadline + 1); assert.equal(result.state.steps[0]?.appliedAt, null); assert.equal(result.state.deadline, held.deadline);
  assert.throws(() => parseMigrationSequenceState({ ...result.state, phase: "succeeded", position: 1, completedAt: result.audit.at,
    steps: result.state.steps.map((step) => ({ ...step, phase: "applied", reason: null, appliedAt: result.audit.at })) }), /resolution|progress/);
});

test("an absent, foreign, running or substituted barrier cannot be replaced by an operator assertion", async (t) => {
  const lab = await sequenceFixture(t, plan(), { probe: "unknown", afterStart: (job, runtime) => { if (job.scope.purpose === "migration") runtime.state("exited", 1); } });
  await lab.prepare(); const held = await lab.drive();
  for (const status of ["absent", "foreign", "unavailable"] as const) await assert.rejects(resolveMigrationSequence(held, lab.plan, statement(held.scope.run), actor,
    { ...lab.ports, native: { observe: () => Promise.resolve({ status }) } }), /current owned fence/);
  for (const change of ["running", "id"] as const) await assert.rejects(resolveMigrationSequence(held, lab.plan, statement(held.scope.run), actor,
    { ...lab.ports, native: { observe: async (job) => { const observed = await lab.ports.native.observe(job); assert.equal(observed.status, "owned");
      return change === "running" ? { ...observed, state: "running" } : { ...observed, id: "f".repeat(64) }; } } }), /current owned fence/);
});

test("slow fence inspection cannot turn an expired sequence into a successful resolution", async (t) => {
  const lab = await sequenceFixture(t, plan(), { probe: "unknown", afterStart: (job, runtime) => { if (job.scope.purpose === "migration") runtime.state("exited", 1); } });
  await lab.prepare(); const held = await lab.drive();
  const result = await resolveMigrationSequence(held, lab.plan, statement(held.scope.run), actor, { ...lab.ports, native: { observe: async (job) => {
    const observed = await lab.ports.native.observe(job); lab.now(held.deadline); return observed;
  } } });
  assert.equal(result.disposition, "failed"); assert.equal(result.state.reason, "deadline"); assert.equal(result.audit.at, held.deadline);
});

test("operator assertions cannot override an attempt whose cleanup has not completed", async (t) => {
  const lab = await sequenceFixture(t, plan(), { admitted: false }); await lab.prepare(); const held = await lab.drive();
  assert.equal(held.steps[0]?.attempts[0]?.execution?.phase, "held");
  await assert.rejects(resolveMigrationSequence(held, lab.plan, statement(held.scope.run), actor, { ...lab.ports,
    native: { observe: () => { throw new Error("unfenced work must be rejected before runtime inspection"); } } }), /every attempt fenced/);
});
