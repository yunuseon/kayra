/* The fake Engine models CAS, delayed requests and automatic rollback independently of the journal. */
/* eslint-disable functional/no-let */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { test } from "node:test";
import type { ServiceAction, ServiceObservation, ServiceVersion, SwarmServicePort } from "../../src/contracts/swarm-service.ts";
import { httpExecution } from "../../src/server/deployment/http-execution.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { fixture, commit } from "./http-test-fixture.ts";

// eslint-disable-next-line functional/prefer-immutable-types -- owns test cleanup
const scenario = async (t: TestContext, promote = true) => {
  const data = await fixture(t);
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
  const ports = { ...data.ports, now: () => clock, native, materialize: () => Promise.resolve({ TOKEN: "private-value" }), routing: () => ({}),
    readiness: { check: (action: ServiceAction) => Promise.resolve({ ...action, checkedAt: clock, status: "ready" as const }) } };
  const start = async (sha: string) => {
    await data.index.prepareBuild("shop", sha, data.builds);
    return data.index.prepareHttpRollout("shop", randomUUID(), sha, { ...data.ports, now: () => clock });
  };
  const execution = httpExecution(data.index, ports);
  const initial = await start(commit);
  if (promote) for (const expected of ["admitted", "applying", "verifying", "succeeded"]) assert.equal(await execution.tick("shop", initial.request), expected);
  return { ...data, ports, start, execution, initial, now: (value: number) => { clock = value; }, delay: (value: boolean) => { delay = value; },
    deliver: () => pending?.(), current: () => current, set: (value: ServiceObservation) => { current = value; }, writes: () => writes };
};

test("untouched A cannot settle while a delayed B write still owns its revision; a fence rejects late B", async (t) => {
  const lab = await scenario(t);
  const b = await lab.start("b".repeat(40));
  await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request);
  lab.delay(true); assert.equal(await lab.execution.tick("shop", b.request), "write-uncertain");
  lab.now(b.deadline + 1); assert.equal(await lab.execution.tick("shop", b.request), "recovering");
  const recovering = await lab.index.httpOperation("shop", b.request); assert.ok(recovering !== undefined);
  const a = lab.current(); assert.equal(a.status, "owned");
  await assert.rejects(lab.index.finishHttpRecovery("shop", b.ticket, "previous-preserved", a, { app: "shop", service: b.service, incarnation: b.action.split(":")[0] ?? "", action: lab.initial.action, plan: lab.initial.plan, checkedAt: b.deadline + 1, status: "ready" }, b.deadline + 1), /fenced outcome/);
  assert.equal(await lab.execution.tick("shop", b.request), "acknowledged");
  assert.equal(lab.deliver(), "conflict");
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
  assert.equal(await lab.execution.tick("shop", b.request), "failed");
  const outcome = await lab.index.httpOperation("shop", b.request);
  assert.equal(outcome?.recovery?.kind, "previous-preserved");
  assert.equal(outcome.recovery.verified?.plan, lab.initial.plan);
  assert.equal(outcome.plan, b.plan);
  await lab.execution.tick("shop", b.request);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "previous");
  assert.equal(lab.writes(), 2);
});

test("automatic rollback is verified without another workload write; restart preserves recovery deadline", async (t) => {
  const lab = await scenario(t); const a = lab.current(); assert.equal(a.status, "owned");
  const b = await lab.start("b".repeat(40));
  await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request);
  const candidate = lab.current(); assert.equal(candidate.status, "owned");
  lab.set({ ...a, action: b.action, plan: b.plan, version: candidate.version + 1, update: "rollback_completed" });
  assert.equal(await lab.execution.tick("shop", b.request), "recovering");
  const deadline = (await lab.index.httpOperation("shop", b.request))?.recoveryDeadline;
  await lab.index.close(); const reopened = await openLifecycleAppIndex(lab.path); t.after(() => reopened.close());
  const execution = httpExecution(reopened, lab.ports);
  assert.equal(await execution.tick("shop", b.request), "failed");
  assert.equal((await reopened.httpOperation("shop", b.request))?.recovery?.kind, "automatic-rollback");
  assert.equal((await reopened.httpOperation("shop", b.request))?.recoveryDeadline, deadline);
  assert.equal(lab.writes(), 2);
  await execution.tick("shop", b.request);
  assert.equal((await reopened.resourceSnapshot())?.charges[0]?.result, "previous");
});

test("explicit compensation seals a fresh A proof used by the next release", async (t) => {
  const lab = await scenario(t); const b = await lab.start("b".repeat(40));
  await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request);
  const bad = lab.current(); assert.equal(bad.status, "owned"); lab.set({ ...bad, update: "paused" });
  assert.equal(await lab.execution.tick("shop", b.request), "recovering");
  assert.equal(await lab.execution.tick("shop", b.request), "acknowledged");
  assert.equal(await lab.execution.tick("shop", b.request), "failed");
  const outcome = await lab.index.httpOperation("shop", b.request);
  assert.equal(outcome?.recovery?.kind, "compensated");
  assert.equal(outcome.recovery.verified?.effect, "restore");
  assert.equal(outcome.recovery.verified.action, b.action + ":restore:1");
  await lab.execution.tick("shop", b.request);
  const c = await lab.start("c".repeat(40));
  assert.deepEqual(c.previous, outcome.recovery.verified);
  for (const expected of ["admitted", "applying", "verifying", "succeeded"]) assert.equal(await lab.execution.tick("shop", c.request), expected);
});

test("recovery expiry holds capacity and never refreshes deadlines or writes", async (t) => {
  const lab = await scenario(t); const b = await lab.start("b".repeat(40));
  await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request);
  lab.now(b.deadline + 1); await lab.execution.tick("shop", b.request);
  const recovering = await lab.index.httpOperation("shop", b.request); assert.ok(recovering?.recoveryDeadline !== null && recovering?.recoveryDeadline !== undefined);
  lab.now(recovering.recoveryDeadline + 1);
  assert.equal(await lab.execution.tick("shop", b.request), "held");
  assert.equal(await lab.execution.tick("shop", b.request), "held");
  assert.equal(lab.writes(), 1);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
  assert.equal((await lab.index.httpOperation("shop", b.request))?.recoveryDeadline, recovering.recoveryDeadline);
});

test("superseded restore revisions get new immutable attempts; delayed old attempts cannot undo recovery", async (t) => {
  const lab = await scenario(t); const b = await lab.start("b".repeat(40));
  await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request);
  const bad = lab.current(); assert.equal(bad.status, "owned"); lab.set({ ...bad, update: "paused" });
  await lab.execution.tick("shop", b.request); lab.delay(true);
  assert.equal(await lab.execution.tick("shop", b.request), "uncertain");
  const first = (await lab.index.httpOperation("shop", b.request))?.steps.at(-1);
  assert.equal(first?.effect, "restore"); assert.equal(first.attempt, 1);
  lab.set({ ...bad, version: bad.version + 1, update: "paused" }); lab.delay(false);
  assert.equal(await lab.execution.tick("shop", b.request), "acknowledged");
  assert.equal(lab.deliver(), "conflict");
  const steps = (await lab.index.httpOperation("shop", b.request))?.steps;
  assert.deepEqual(steps?.[1], first);
  assert.equal(steps[2]?.attempt, 2);
  assert.equal(await lab.execution.tick("shop", b.request), "failed");
  assert.equal((await lab.index.httpOperation("shop", b.request))?.recovery?.verified?.action, b.action + ":restore:2");
});

test("failed initial release retains a clean zero-replica name barrier before freeing capacity", async (t) => {
  const lab = await scenario(t, false); const a = lab.initial;
  await lab.execution.tick("shop", a.request); await lab.execution.tick("shop", a.request); await lab.execution.tick("shop", a.request);
  lab.now(a.deadline + 1); assert.equal(await lab.execution.tick("shop", a.request), "recovering");
  assert.equal(await lab.execution.tick("shop", a.request), "acknowledged");
  const tombstone = lab.current(); assert.equal(tombstone.status, "owned");
  assert.equal(tombstone.retainedInputsCleared, false);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
  assert.equal(await lab.execution.tick("shop", a.request), "acknowledged");
  assert.equal(await lab.execution.tick("shop", a.request), "failed");
  const outcome = await lab.index.httpOperation("shop", a.request);
  assert.equal(outcome?.recovery?.kind, "removed-unverified");
  assert.equal(outcome.recovery.verified, null);
  const kept = lab.current(); assert.equal(kept.status, "owned"); assert.equal(kept.id, tombstone.id); assert.equal(kept.replicas, 0);
  // Preparing B reconciles the crash window between the failed receipt and host accounting.
  const b = await lab.start("b".repeat(40));
  assert.equal(b.previous, null);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "absent");
  for (const expected of ["admitted", "applying", "verifying", "succeeded"]) assert.equal(await lab.execution.tick("shop", b.request), expected);
});

test("an absent first create is fenced by a retained name so its late arrival cannot expose the candidate", async (t) => {
  const lab = await scenario(t, false); const a = lab.initial;
  await lab.execution.tick("shop", a.request); await lab.execution.tick("shop", a.request); lab.delay(true);
  assert.equal(await lab.execution.tick("shop", a.request), "write-uncertain");
  lab.now(a.deadline + 1); await lab.execution.tick("shop", a.request);
  assert.equal(await lab.execution.tick("shop", a.request), "acknowledged");
  assert.equal(lab.deliver(), "conflict");
  assert.equal(await lab.execution.tick("shop", a.request), "failed");
  await lab.execution.tick("shop", a.request);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "absent");
});

test("unstarted admission can expire safely, including a crash after the host reservation", async (t) => {
  const lab = await scenario(t, false); const a = lab.initial;
  await lab.index.admitHttpRollout("shop", a.ticket, lab.ports);
  lab.now(a.deadline + 1);
  assert.equal(await lab.execution.tick("shop", a.request), "failed");
  const operation = await lab.index.httpOperation("shop", a.request);
  assert.equal(operation?.recovery?.kind, "unstarted");
  assert.deepEqual(operation.steps, []);
  assert.equal(lab.writes(), 0);
  await lab.execution.tick("shop", a.request);
  assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "absent");
});

test("restart after restore acknowledgement seals A without dispatching restoration again", async (t) => {
  const lab = await scenario(t); const b = await lab.start("b".repeat(40));
  await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request);
  const bad = lab.current(); assert.equal(bad.status, "owned"); lab.set({ ...bad, update: "paused" });
  await lab.execution.tick("shop", b.request); await lab.execution.tick("shop", b.request);
  const recorded = await lab.index.httpOperation("shop", b.request); const writes = lab.writes();
  await lab.index.close(); const reopened = await openLifecycleAppIndex(lab.path); t.after(() => reopened.close());
  assert.equal(await httpExecution(reopened, lab.ports).tick("shop", b.request), "failed");
  const outcome = await reopened.httpOperation("shop", b.request);
  assert.equal(outcome?.recovery?.kind, "compensated");
  assert.equal(outcome.recoveryDeadline, recorded?.recoveryDeadline);
  assert.equal(lab.writes(), writes);
  // The next request settles any remaining conservative host charge first.
  await reopened.prepareBuild("shop", "c".repeat(40), lab.builds);
  const c = await reopened.prepareHttpRollout("shop", randomUUID(), "c".repeat(40), lab.ports);
  assert.deepEqual(c.previous, outcome.recovery.verified);
  assert.equal((await reopened.resourceSnapshot())?.charges[0]?.result, "previous");
});
