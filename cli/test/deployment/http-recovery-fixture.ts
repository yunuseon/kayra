/* Owns the fake Engine and delayed requests. */
/* eslint-disable functional/no-let */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { ApplicationPlan } from "../../src/contracts/http-plan.ts";
import type { ServiceAction, ServiceObservation, ServiceVersion, SwarmServicePort } from "../../src/contracts/swarm-service.ts";
import { httpExecution } from "../../src/server/deployment/http-execution.ts";
import { fixture, commit } from "./http-test-fixture.ts";

// eslint-disable-next-line functional/prefer-immutable-types -- owns test cleanup
export const recoveryFixture = async (t: TestContext, promote = true, transform: (plan: ApplicationPlan) => ApplicationPlan = (plan) => plan) => {
  const data = await fixture(t);
  const plans = { ...data.ports, preview: async (...args: Readonly<Parameters<typeof data.ports.preview>>) => transform(await data.ports.preview(...args)) };
  let clock = 2000;
  let current: ServiceObservation = { status: "absent" };
  let delay = false;
  let pending: (() => string) | undefined;
  let writes = 0;
  const matches = (expected: ServiceVersion | null) => expected === null ? current.status === "absent" : current.status === "owned" && current.id === expected.id && current.version === expected.version;
  const apply = (action: ServiceAction, expected: ServiceVersion | null) => {
    if (!matches(expected)) return "conflict" as const;
    writes += 1;
    current = { status: "owned", id: "s".repeat(25), version: expected === null ? 41 : expected.version + 1, action: action.action, plan: action.plan, effect: action.effect,
      taskPlan: action.plan, taskEffect: action.effect, tombstone: false, retainedInputsCleared: false, specMatches: true, replicas: 1, endpoint: "vip", update: "completed",
      tasks: [{ id: String(writes).padStart(25, "t"), incarnation: action.incarnation, action: action.action, plan: action.plan, effect: action.effect, state: "running", desired: "running", health: "healthy" }] };
    return "acknowledged" as const;
  };
  const native: SwarmServicePort = {
    observe: () => Promise.resolve(current),
    observeDesired: (action) => Promise.resolve(current.status === "owned" ? { ...current, specMatches: !current.tombstone && current.taskPlan === action.plan && current.taskEffect === action.effect && current.tasks.some((task) => task.desired === "running" && task.action === action.action) } : current),
    apply: (action, expected) => {
      if (delay) { pending = () => apply(action, expected); return Promise.resolve("uncertain"); }
      return Promise.resolve(apply(action, expected));
    },
    fence: (action, expected) => {
      if (!matches(expected) || current.status !== "owned") return Promise.resolve("conflict");
      writes += 1; current = { ...current, version: current.version + 1, action: action.action, effect: "fence" };
      return Promise.resolve("acknowledged");
    },
    tombstone: (action, expected) => {
      if (!matches(expected)) return Promise.resolve("conflict");
      writes += 1;
      current = { status: "owned", id: "s".repeat(25), version: expected === null ? 41 : expected.version + 1, action: action.action, plan: action.plan, effect: action.effect,
        taskPlan: action.plan, taskEffect: action.effect, tombstone: true, retainedInputsCleared: current.status === "absent" || (current.status === "owned" && current.tombstone), specMatches: false, replicas: 0, endpoint: "dnsrr", update: null, tasks: [] };
      return Promise.resolve("acknowledged");
    },
  };
  const ports = { ...plans, now: () => clock, native, materialize: () => Promise.resolve({ TOKEN: "private-value" }), routing: () => ({}),
    readiness: { check: (action: ServiceAction) => Promise.resolve({ ...action, checkedAt: clock, status: "ready" as const }) } };
  const start = async (sha: string) => {
    await data.index.prepareBuild("shop", sha, data.builds);
    return data.index.prepareHttpRollout("shop", randomUUID(), sha, { ...plans, now: () => clock });
  };
  const execution = httpExecution(data.index, ports);
  const initial = await start(commit);
  if (promote) for (const expected of ["admitted", "applying", "verifying", "succeeded"]) assert.equal(await execution.tick("shop", initial.request), expected);
  return { ...data, ports, start, execution, initial, now: (value: number) => { clock = value; }, delay: (value: boolean) => { delay = value; },
    deliver: () => pending?.(), current: () => current, set: (value: ServiceObservation) => { current = value; }, writes: () => writes };
};

