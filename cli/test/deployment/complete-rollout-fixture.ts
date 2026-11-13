/* eslint-disable functional/no-let, functional/prefer-immutable-types -- fixture owns callbacks, clocks and test cleanup */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { recoveryFixture } from "./http-recovery-fixture.ts";
import { sequenceFixture } from "./migration-sequence-fixture.ts";
import { completePorts } from "./rollout-plan-fixture.ts";
import { parseRolloutPlan } from "../../src/contracts/rollout-plan.ts";
import { rolloutExecution } from "../../src/server/deployment/rollout-execution.ts";

export const completeRolloutFixture = async (t: TestContext, running = true, probe: "applied" | "unknown" = "applied", failure = false) => {
  const lab = await recoveryFixture(t); const jobs = await sequenceFixture(t, undefined, { probe, afterStart: (job, runtime) => {
    if (job.scope.purpose === "migration") { if (failure) runtime.state("exited", 1); else if (running) runtime.state("running"); }
  } }); jobs.now(lab.ports.now());
  const ports = { ...lab.ports, ...lab.artifacts, jobs: jobs.ports.native, materialize: () => Promise.resolve({ TOKEN: "private-value", RELEASE: "A" }) };
  const original = completePorts(lab.ports, !failure); const plans = { ...original, preview: async (...args: Readonly<Parameters<typeof original.preview>>) => {
    const plan = await original.preview(...args); const first = plan.rollout.migrations[0]; assert.ok(first);
    const parsed = parseRolloutPlan({ ...plan, rollout: { ...plan.rollout, migrations: [first, { ...first, id: "seed" }] } }); assert.ok(parsed.ok); return parsed.value;
  } };
  await lab.index.prepareBuild("shop", "b".repeat(40), lab.builds); const parent = await lab.index.prepareRollout("shop", randomUUID(), "b".repeat(40), plans);
  const owner = rolloutExecution(lab.index, ports);
  const drive = async (predicate: (operation: NonNullable<Awaited<ReturnType<typeof lab.index.rolloutOperation>>>) => boolean) => {
    for (let count = 0; count < 60; count++) { await owner.tick("shop", parent.preparation.run); const state = await lab.index.rolloutOperation("shop", parent.preparation.run); assert.ok(state); if (predicate(state)) return state; }
    throw new Error("rollout did not reach cancellation checkpoint");
  };
  const stop = async () => {
    for (let count = 0; count < 60; count++) { const phase = await owner.tick("shop", parent.preparation.run); if (phase === "cancelled" || phase === "held") return phase; }
    throw new Error("rollout cancellation did not settle");
  };
  return { ...lab, jobs, ports, plans, parent, owner, drive, stop };
};

