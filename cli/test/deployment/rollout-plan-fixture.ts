import { strict as assert } from "node:assert";
import { parseRolloutPlan } from "../../src/contracts/rollout-plan.ts";
import type { fixture } from "./http-test-fixture.ts";

export const completePorts = (ports: Awaited<ReturnType<typeof fixture>>["ports"], unsafe = false) => ({ ...ports,
  preview: async (...input: Readonly<Parameters<typeof ports.preview>>) => {
    const workload = await ports.preview(...input);
    const checked = parseRolloutPlan({ version: 2, runtime: "swarm", workload, policy: { version: 1, migrationTimeoutCeilingSeconds: 90, schedulingSeconds: 90, cleanupSeconds: 30, maximumAttempts: 8 },
      rollout: { ...workload.rollout, migrations: [{ id: "schema", service: "web", command: ["node", "migrate.mjs"], timeout_seconds: 30,
        recovery: unsafe ? { kind: "status-probe", command: ["node", "status.mjs"], timeout_seconds: 10 } : { kind: "replay-safe" } }] } });
    assert.ok(checked.ok); return checked.value;
  },
});
