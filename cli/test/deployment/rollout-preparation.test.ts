/* eslint-disable functional/no-let, functional/prefer-immutable-types -- owns test contexts, journal handles and runtime controls */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { parseRolloutPlan, rolloutOperationSeconds } from "../../src/contracts/rollout-plan.ts";
import { parseApplicationPlan } from "../../src/contracts/application-plan.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { parseRolloutPreparation, rolloutPreparation } from "../../src/server/deployment/rollout-preparation.ts";
import type { RolloutPreparation } from "../../src/server/deployment/rollout-preparation.ts";
import { sequenceFixture } from "./migration-sequence-fixture.ts";

const raw: unknown = JSON.parse(readFileSync(new URL("../../../ci/tests/swarm-http/native-plan.json", import.meta.url), "utf8"));
const http = parseApplicationPlan(raw); assert.ok(http.ok); const workload = http.value;
const run = "00000000-0000-4000-8000-000000000001";
const plan = (migrations = true, unsafe = false) => {
  const parsed = parseRolloutPlan({ version: 2, runtime: "swarm", workload, policy: { version: 1, migrationTimeoutCeilingSeconds: 90, schedulingSeconds: 90, cleanupSeconds: 30, maximumAttempts: 8 },
    rollout: { ...workload.rollout, migrations: migrations ? ["schema", "seed"].map((id) => ({ id, service: "web", command: ["node", "migrate.mjs", id], timeout_seconds: 30,
      recovery: unsafe ? { kind: "status-probe", command: ["node", "status.mjs"], timeout_seconds: 10 } : { kind: "replay-safe" } })) : [] } });
  assert.ok(parsed.ok); return parsed.value;
};
const fixture = async (t: TestContext, input = plan(), options: Parameters<typeof sequenceFixture>[2] = {}) => {
  const lab = await sequenceFixture(t, undefined, options); const path = join(lab.path, "preparation"); await mkdir(path);
  let journal = await openJournal(path); let allowed = true;
  const ports: Parameters<typeof rolloutPreparation>[1] = { ...lab.ports,
    authorize: () => Promise.resolve(allowed), materialize: () => Promise.resolve({ TOKEN: "secret-value", RELEASE: "A" }) };
  let owner = rolloutPreparation(journal, ports);
  t.after(() => journal.close());
  const drive = async (until: (state: RolloutPreparation) => boolean = (state) => state.phase === "ready" || state.phase === "held") => {
    for (let number = 0; number < 200; number++) { const state = await owner.tick(); if (until(state)) return state; }
    throw new Error("rollout preparation did not converge");
  };
  return { ...lab, path, ports, owner: () => owner, journal: () => journal, prepare: () => owner.prepare(input, run), drive,
    authorize: (value: boolean) => { allowed = value; },
    reopen: async (changed: Partial<typeof ports> = {}) => { await journal.close(); journal = await openJournal(path, "existing"); owner = rolloutPreparation(journal, { ...ports, ...changed }); },
  };
};

test("complete rollout preparation owns ordered migration evidence before issuing the HTTP deadline", async (t) => {
  const lab = await fixture(t); const prepared = await lab.prepare();
  assert.equal(prepared.httpDeadline, null); assert.notEqual(prepared.plan, prepared.workload);
  assert.equal(prepared.deadline, prepared.createdAt + rolloutOperationSeconds(plan()) * 1000);
  const ready = await lab.drive(); assert.equal(ready.phase, "ready"); assert.equal(ready.sequence?.phase, "succeeded");
  assert.equal(ready.httpDeadline, 91_000); assert.equal(ready.sequence.steps.length, 2);
  assert.equal([...lab.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 2);
  assert.ok(!JSON.stringify(await lab.journal().read()).includes("secret-value"));
});

test("restart after migration completion reconstructs the handoff without replay or refreshed deadlines", async (t) => {
  const lab = await fixture(t); const prepared = await lab.prepare();
  await lab.drive((state) => state.sequence?.phase === "succeeded"); await lab.reopen();
  assert.equal((await lab.prepare()).deadline, prepared.deadline);
  const ready = await lab.owner().tick(); assert.equal(ready.phase, "ready"); lab.now(50_000); await lab.reopen();
  assert.deepEqual(await lab.owner().tick(), ready); assert.equal([...lab.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 2);
});

test("unresolved migration outcomes keep HTTP blocked and retain fenced runtime evidence", async (t) => {
  const lab = await fixture(t, plan(true, true), { probe: "unknown", afterStart: (job, runtime) => { if (job.scope.purpose === "migration") runtime.state("exited", 1); } });
  await lab.prepare(); const held = await lab.drive(); assert.equal(held.phase, "held"); assert.equal(held.reason, "migration");
  assert.equal(held.httpDeadline, null); assert.equal(held.sequence?.reason, "probe-unknown");
  assert.equal(held.sequence.steps[0]?.attempts.filter((attempt) => attempt.purpose === "migration").length, 1);
  await lab.reopen(); assert.deepEqual(await lab.owner().tick(), held);
});

test("HTTP-only preparation is bounded and expired preparation cannot gain a fresh window", async (t) => {
  const noJobs = await fixture(t, plan(false)); const prepared = await noJobs.prepare(); assert.equal(prepared.migrationDeadline, 91_000);
  const ready = await noJobs.owner().tick(); assert.equal(ready.phase, "ready"); assert.equal(noJobs.nodes.size, 0);
  const expired = await fixture(t); const intent = await expired.prepare(); expired.now(intent.migrationDeadline);
  await expired.reopen(); const held = await expired.owner().tick(); assert.equal(held.phase, "held"); assert.equal(held.reason, "deadline");
  assert.equal(held.httpDeadline, null); assert.equal(expired.nodes.size, 0);
});

test("a slow artifact read cannot issue HTTP authority after the migration handoff expires", async (t) => {
  const lab = await fixture(t); const prepared = await lab.prepare(); await lab.drive((state) => state.sequence?.phase === "succeeded");
  await lab.reopen({ read: async (digest) => { const bytes = await lab.artifacts.read(digest); lab.now(prepared.migrationDeadline); return bytes; } });
  const held = await lab.owner().tick(); assert.equal(held.phase, "held"); assert.equal(held.httpDeadline, null);
});

test("preparation binds the whole plan, source, workload and run and refuses competing writers", async (t) => {
  const lab = await fixture(t); const prepared = await lab.prepare();
  assert.throws(() => rolloutPreparation(lab.journal(), lab.ports), /already has/);
  await assert.rejects(openJournal(lab.path, "existing"), /locked|busy/);
  await assert.rejects(lab.owner().prepare(plan(false), run), /conflicts/);
  assert.throws(() => parseRolloutPreparation({ ...prepared, phase: "ready", httpDeadline: 91_000 }), /inconsistent/);
  await lab.reopen({ read: async (digest) => digest === prepared.workload ? "{}" : lab.artifacts.read(digest) });
  await assert.rejects(lab.owner().tick(), /projection changed/); assert.equal(lab.nodes.size, 0);
});

test("parent authorization is checked again before migration effects", async (t) => {
  const lab = await fixture(t); await lab.prepare(); lab.authorize(false);
  const held = await lab.drive(); assert.equal(held.phase, "held"); assert.equal(held.httpDeadline, null);
  assert.equal([...lab.nodes.values()].reduce((sum, node) => sum + node.executions(), 0), 0);
});
