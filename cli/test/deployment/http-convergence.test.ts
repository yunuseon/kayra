import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ServiceAction, ServiceObservation } from "../../src/contracts/swarm-service.ts";
import type { RoutedReadiness } from "../../src/contracts/routed-readiness.ts";
import { convergedHttp, routedHttp } from "../../src/server/deployment/http-convergence.ts";

const action: ServiceAction = { app: "shop", service: "web", incarnation: "11111111-1111-4111-8111-111111111111", action: "11111111-1111-4111-8111-111111111111:2", plan: "a".repeat(64), effect: "apply", deadline: 91_000 };
const task = { id: "t".repeat(25), incarnation: action.incarnation, action: action.action, plan: action.plan, effect: action.effect, desired: "running", state: "running", health: "healthy" as const };
const observed = {
  status: "owned" as const, id: "s".repeat(25), version: 43, action: action.action, plan: action.plan, taskPlan: action.plan, effect: action.effect, taskEffect: action.effect,
  tombstone: false, retainedInputsCleared: false, specMatches: true, replicas: 1, endpoint: "vip" as const, update: "completed", tasks: [task],
};
const routed: RoutedReadiness = { ...action, checkedAt: 2000, status: "ready" };

test("current convergence ignores historical failures but waits for old draining tasks", () => {
  assert.equal(convergedHttp(action, { ...observed, tasks: [...observed.tasks, { ...task, id: "old", state: "failed", desired: "shutdown", health: "unhealthy" }] }), true);
  assert.equal(convergedHttp(action, { ...observed, tasks: [...observed.tasks, { ...task, id: "old", state: "running", desired: "shutdown" }] }), false);
  const failures: readonly ServiceObservation[] = [
    { status: "absent" }, { status: "unavailable" }, { ...observed, specMatches: false }, { ...observed, tombstone: true }, { ...observed, update: "updating" },
    { ...observed, taskPlan: "b".repeat(64) }, { ...observed, taskEffect: "restore" }, { ...observed, replicas: 0 }, { ...observed, endpoint: "dnsrr" },
    { ...observed, tasks: [{ ...task, health: "starting" }] }, { ...observed, tasks: [{ ...task, action: action.incarnation + ":1" }] },
    { ...observed, tasks: [{ ...task, incarnation: "other" }] }, { ...observed, tasks: [] },
  ];
  for (const observation of failures) assert.equal(convergedHttp(action, observation), false);
});

test("routed evidence is fresh and binds the same immutable request rather than merely a hostname", () => {
  assert.equal(routedHttp(action, routed, 2000), true);
  for (const evidence of [ { ...routed, status: "unready" }, { ...routed, checkedAt: 0 }, { ...routed, checkedAt: 2001 }, { ...routed, plan: "b".repeat(64) },
    { ...routed, action: action.incarnation + ":1" }, { ...routed, app: "other" }, { ...routed, service: "worker" },
  ] as const) assert.equal(routedHttp(action, evidence, 2000), false);
  assert.equal(routedHttp(action, routed, 4001), false);
  assert.equal(routedHttp(action, routed, Number.NaN), false);
});
