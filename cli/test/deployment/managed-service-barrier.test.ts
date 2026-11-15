/* eslint-disable functional/no-let, functional/prefer-immutable-types -- owns test runtime and restart handles */
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedServiceAction } from "../../src/contracts/managed-swarm-service.ts";
import type { ServiceObservation, ServiceVersion } from "../../src/contracts/swarm-service.ts";
import { managedServiceBarrier } from "../../src/server/deployment/managed-service-barrier.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";

const fixture = async (t: TestContext, absent = false) => {
  const { plan } = await managedPlanFixture(); const service = plan.services["worker"]; assert.ok(service);
  const path = await mkdtemp(join(tmpdir(), "kayra-managed-barrier-")); const artifacts = await openArtifactStore(join(path, "artifacts"));
  let journal = await openJournal(path); let clock = 1000; let calls = 0; let lose = false; let admitted = true; let draining = false; let scrubConflict = false;
  const id = "s".repeat(25); const prior = absent ? [] : [{ id, version: 5 }];
  const action: ManagedServiceAction = { app: service.owner.app, service: service.service, incarnation: service.owner.incarnation, dataOwner: service.owner.dataOwner,
    action: service.owner.incarnation + ":3", plan: managedServiceDigest(service), deadline: 91000, effect: "remove" };
  const old: Extract<ServiceObservation, { readonly status: "owned" }> = { status: "owned", id, version: 5, action: service.owner.incarnation + ":2", effect: "apply", taskEffect: "apply", plan: action.plan, taskPlan: action.plan,
    tombstone: false, retainedInputsCleared: false, specMatches: null, replicas: 1, endpoint: "vip", update: "completed", tasks: [] };
  let observed: ServiceObservation = absent ? { status: "absent" } : old;
  const ports = { ...artifacts, now: () => clock, authorize: () => Promise.resolve(admitted), runtime: {
    observe: () => Promise.resolve(observed),
    tombstone: (requested: ManagedServiceAction, expected: ServiceVersion | null) => {
      calls++;
      if (observed.status === "owned" && (observed.id !== expected?.id || observed.version !== expected.version)) return Promise.resolve("conflict" as const);
      if (scrubConflict && requested.effect === "scrub" && observed.status === "owned") {
        scrubConflict = false; observed = { ...observed, version: observed.version + 1 }; return Promise.resolve("conflict" as const);
      }
      const version = observed.status === "owned" ? observed.version + 1 : 1;
      observed = { ...old, version, action: requested.action, effect: requested.effect, replicas: 0, endpoint: "dnsrr", tombstone: true, retainedInputsCleared: requested.effect === "scrub",
        tasks: draining ? [{ id: "t".repeat(25), incarnation: action.incarnation, effect: "apply", action: old.action, plan: old.plan, desired: "shutdown", state: "running", health: "absent" }] : [] };
      return lose ? Promise.reject(new Error("private lost acknowledgement")) : Promise.resolve("acknowledged" as const);
    },
  } };
  let owner = managedServiceBarrier(journal, ports);
  t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  return { service, action, old, prior, ports, owner: () => owner, journal: () => journal, calls: () => calls,
    prepare: () => owner.prepare(service, action, prior), now: (value: number) => { clock = value; }, lose: () => { lose = true; }, conflictScrub: () => { scrubConflict = true; }, deny: () => { admitted = false; },
    drain: (value: boolean) => { draining = value; if (!value && observed.status === "owned") observed = { ...observed, tasks: [] }; },
    observe: (value: ServiceObservation) => { observed = value; },
    reopen: async () => { await journal.close(); journal = await openJournal(path, "existing"); owner = managedServiceBarrier(journal, ports); },
  };
};

test("managed barrier waits for draining tasks then scrubs PreviousSpec under the original deadline", async (t) => {
  const lab = await fixture(t); const prepared = await lab.prepare(); lab.lose(); lab.drain(true);
  assert.equal((await lab.owner().tick()).steps.length, 1); assert.equal(lab.calls(), 1);
  await lab.reopen(); assert.equal((await lab.owner().tick()).steps.length, 1); assert.equal(lab.calls(), 1);
  lab.drain(false); const scrub = await lab.owner().tick(); assert.equal(scrub.steps.at(-1)?.effect, "scrub"); assert.equal(lab.calls(), 2);
  await lab.reopen(); const done = await lab.owner().tick(); assert.equal(done.phase, "complete"); assert.equal(done.proof?.native.version, 7);
  lab.now(999999); assert.deepEqual(await lab.prepare(), done); assert.equal(done.action.deadline, prepared.action.deadline); assert.equal(lab.calls(), 2);
  assert.equal(JSON.stringify(done).includes("private"), false);
});

test("an uncertain unchanged CAS is never dispatched twice and expiry remains held after restart", async (t) => {
  const lab = await fixture(t); const initial = await lab.prepare(); const prior = lab.prior[0]; assert.ok(prior);
  await lab.journal().write({ ...initial, steps: [{ effect: "remove", attempt: 1, expected: prior }] }); await lab.reopen();
  assert.equal((await lab.owner().tick()).phase, "fencing"); assert.equal(lab.calls(), 0);
  lab.now(lab.action.deadline); const held = await lab.owner().tick(); assert.equal(held.phase, "held"); assert.equal(held.reason, "deadline");
  await lab.reopen(); assert.deepEqual(await lab.owner().tick(), held); assert.equal(lab.calls(), 0);
});

test("an absent service gets one inert name reservation and journal reopen never repeats it", async (t) => {
  const lab = await fixture(t, true); await lab.prepare(); lab.lose(); await lab.owner().tick(); assert.equal(lab.calls(), 1);
  await lab.reopen(); await lab.owner().tick(); assert.equal(lab.calls(), 1);
  await lab.owner().tick(); const done = await lab.owner().tick(); assert.equal(done.phase, "complete"); assert.equal(done.proof?.native.version, 2); assert.equal(lab.calls(), 2);
});

test("a delayed old create winning the first race is fenced by a new recorded CAS before proof", async (t) => {
  const lab = await fixture(t, true); const initial = await lab.prepare();
  await lab.journal().write({ ...initial, steps: [{ effect: "remove", attempt: 1, expected: null }] }); lab.observe({ ...lab.old, version: 1 }); await lab.reopen();
  await lab.owner().tick(); const removing = await lab.owner().tick(); assert.equal(removing.steps.at(-1)?.attempt, 2); assert.equal(lab.calls(), 1);
  await lab.owner().tick(); const done = await lab.owner().tick(); assert.equal(done.phase, "complete"); assert.equal(done.proof?.native.version, 3);
});

test("changed physical identity, denied authorization and missing recorded service cannot prove cleanup", async (t) => {
  const denied = await fixture(t); await denied.prepare(); denied.deny(); assert.equal((await denied.owner().tick()).reason, "authorization"); assert.equal(denied.calls(), 0);
  const replaced = await fixture(t); await replaced.prepare(); replaced.observe({ ...replaced.old, id: "x".repeat(25) }); assert.equal((await replaced.owner().tick()).reason, "runtime"); assert.equal(replaced.calls(), 0);
  const missing = await fixture(t); await missing.prepare(); missing.observe({ status: "absent" }); assert.equal((await missing.owner().tick()).phase, "held"); assert.equal(missing.calls(), 0);
});


test("native metadata advancing during scrub requires a new bounded recorded CAS, never rebases the old intent", async (t) => {
  const lab = await fixture(t); await lab.prepare(); await lab.owner().tick(); lab.conflictScrub();
  const conflicted = await lab.owner().tick(); assert.equal(conflicted.steps.at(-1)?.expected?.version, 6);
  await lab.reopen(); const retry = await lab.owner().tick(); assert.equal(retry.steps.at(-1)?.attempt, 2); assert.equal(retry.steps.at(-1)?.expected?.version, 7);
  const complete = await lab.owner().tick(); assert.equal(complete.phase, "complete"); assert.equal(complete.proof?.native.version, 8); assert.equal(lab.calls(), 3);
});

test("an unexpected application write after scrubbing starts cannot become cleanup proof", async (t) => {
  const lab = await fixture(t); await lab.prepare(); await lab.owner().tick(); await lab.owner().tick();
  lab.observe({ ...lab.old, version: 100 });
  const held = await lab.owner().tick(); assert.equal(held.phase, "held"); assert.equal(held.reason, "runtime"); assert.equal(held.proof, null); assert.equal(lab.calls(), 2);
});
