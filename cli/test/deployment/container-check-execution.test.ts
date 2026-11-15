/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- models execution evidence and interrupted acknowledgements */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { parseCheckTarget } from "../../src/contracts/container-check.ts";
import { managedServiceName, managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import { describeManagedCheck } from "../../src/server/deployment/managed-check-description.ts";
import { containerCheckExecution, parseContainerCheckExecution } from "../../src/server/deployment/container-check-execution.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";

const fixture = async (t: TestContext, deadline = 91000) => {
  const data = await managedPlanFixture(); const checked = parseManagedApplicationPlan({ ...data.plan, rollout: { ...data.plan.rollout, checks: [{ id: "confirm", service: "web", command: ["node", "-e", "process.exit(0)"], timeout_seconds: 2 }] } }); assert.ok(checked.ok); const application = checked.value; const web = application.services["web"]; assert.ok(web);
  const target = parseCheckTarget({ action: { app: web.owner.app, incarnation: web.owner.incarnation, dataOwner: web.owner.dataOwner, service: web.service, action: web.owner.incarnation + ":2", effect: "apply", plan: managedServiceDigest(web), deadline: 91000 }, service: "s".repeat(25), task: "t".repeat(25), container: "c".repeat(64) }); assert.ok(target.ok);
  const description = describeManagedCheck(application, randomUUID(), "confirm", target.value, deadline); assert.ok(description.ok); const plan = description.value;
  const path = await mkdtemp(join(tmpdir(), "kayra-container-check-")); const artifacts = await openArtifactStore(join(path, "artifacts")); let journal = await openJournal(path); let clock = 1000; let creates = 0; let starts = 0; let loseCreate = false; let loseStart = false; let fast = false; let admitted = true; let poison = false;
  const processes = new Map<string, { running: boolean; exitCode: number }>();
  const runtime = {
    create: async () => { const state = parseContainerCheckExecution(await journal.read()); assert.equal(state.phase, "creating"); creates++; const id = String(creates).padStart(64, "a"); processes.set(id, { running: false, exitCode: 0 });
      if (loseCreate) { loseCreate = false; throw new Error("PRIVATE_CREATE_ACK_FAILURE"); } return { status: "created" as const, id };
    },
    start: async (_plan: unknown, id: string, deadline: number) => { const state = parseContainerCheckExecution(await journal.read()); assert.equal(state.phase, "starting"); assert.equal(state.id, id); assert.equal(state.executionDeadline, deadline); starts++; processes.set(id, { running: !fast, exitCode: 0 }); return loseStart ? "uncertain" as const : "acknowledged" as const; },
    observe: (_plan: unknown, id: string) => { const process = processes.get(id); return Promise.resolve(process === undefined ? { status: "absent" as const } : { status: "owned" as const, id, running: process.running, exitCode: process.running ? null : process.exitCode }); },
  };
  const ports = { ...artifacts, now: () => clock, runtime, authorize: () => Promise.resolve(admitted) };
  const view = () => ({ read: journal.read, write: async (value: Parameters<typeof journal.write>[0]) => { await journal.write(value); if (poison) throw new Error("uncertain synchronized acknowledgement"); } });
  let owner = containerCheckExecution(view(), ports); t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  return { plan, application, target: target.value, processes, ports, owner: () => owner, journal: () => journal, prepare: () => owner.prepare(plan), creates: () => creates, starts: () => starts,
    loseCreate: () => { loseCreate = true; }, loseStart: () => { loseStart = true; }, fast: () => { fast = true; }, deny: () => { admitted = false; }, now: (value: number) => { clock = value; }, poison: () => { poison = true; },
    finish: (code = 0) => { for (const [id] of processes) processes.set(id, { running: false, exitCode: code }); },
    reopen: async () => { await journal.close(); poison = false; journal = await openJournal(path, "existing"); owner = containerCheckExecution(view(), ports); },
  };
};

test("an acknowledged check executes inside its selected task and records known completion after restart", async (t) => {
  const lab = await fixture(t); await lab.prepare(); await lab.owner().tick(); const started = await lab.owner().tick(); assert.equal(started.phase, "observing"); assert.equal(started.executionDeadline, 3000); assert.equal(lab.starts(), 1);
  await lab.reopen(); lab.finish(); const done = await lab.owner().tick(); assert.equal(done.phase, "complete"); assert.equal(done.evidence?.exitCode, 0); assert.equal(lab.creates(), 1); assert.equal(lab.starts(), 1);
  lab.now(999999); assert.deepEqual(await lab.prepare(), done); assert.deepEqual(await lab.owner().tick(), done);
});

test("lost Start acknowledgement can be recovered only from observed running evidence", async (t) => {
  const lab = await fixture(t); await lab.prepare(); await lab.owner().tick(); lab.loseStart(); const original = await lab.owner().tick(); assert.equal(original.phase, "starting"); assert.equal(original.acknowledgedAt, null);
  await lab.reopen(); const running = await lab.owner().tick(); assert.equal(running.runningAt, 1000); lab.finish(); const done = await lab.owner().tick(); assert.equal(done.phase, "complete"); assert.equal(done.executionDeadline, original.executionDeadline); assert.equal(lab.starts(), 1);
});

test("a fast stopped exec with exit zero after an uncertain Start is unknown and never blindly repeated", async (t) => {
  const lab = await fixture(t); await lab.prepare(); await lab.owner().tick(); lab.fast(); lab.loseStart(); await lab.owner().tick(); await lab.reopen();
  const held = await lab.owner().tick(); assert.equal(held.phase, "held"); assert.equal(held.reason, "unknown-start"); assert.equal(held.evidence, null); assert.equal(lab.starts(), 1);
  await lab.reopen(); assert.deepEqual(await lab.owner().tick(), held); assert.equal(lab.starts(), 1);
});

test("restart after Start intent but before dispatch cannot infer success from Docker's initial exit zero", async (t) => {
  const lab = await fixture(t); await lab.prepare(); const state = await lab.owner().tick(); await lab.journal().write({ ...state, phase: "starting", executionDeadline: 3000 }); await lab.reopen();
  assert.equal((await lab.owner().tick()).reason, "unknown-start"); assert.equal(lab.starts(), 0);
});

test("uncertain Create IDs remain inert while a new synchronized ID alone can be started", async (t) => {
  const lab = await fixture(t); await lab.prepare(); lab.loseCreate(); const unknown = await lab.owner().tick(); assert.equal(unknown.phase, "creating"); assert.equal(unknown.id, null);
  await lab.reopen(); await lab.owner().tick(); await lab.owner().tick(); assert.equal(lab.creates(), 2); assert.equal(lab.starts(), 1);
  const running = [...lab.processes.values()].filter((process) => process.running); assert.equal(running.length, 1); assert.equal(JSON.stringify(await lab.journal().read()).includes("PRIVATE"), false);
});

test("scheduling and execution deadlines survive restart without claiming an expired process stopped", async (t) => {
  const pending = await fixture(t, 600000); const initial = await pending.prepare(); pending.now(initial.startDeadline); await pending.reopen(); assert.equal((await pending.owner().tick()).reason, "deadline"); assert.equal(pending.creates(), 0);
  const running = await fixture(t); await running.prepare(); await running.owner().tick(); const start = await running.owner().tick(); assert.ok(start.executionDeadline); await running.reopen(); running.now(start.executionDeadline);
  const held = await running.owner().tick(); assert.equal(held.reason, "deadline"); assert.ok([...running.processes.values()].some((process) => process.running)); assert.equal(running.starts(), 1);
});

test("authorization denial and uncertain journal persistence cannot dispatch Start", async (t) => {
  const denied = await fixture(t); await denied.prepare(); denied.deny(); assert.equal((await denied.owner().tick()).reason, "authorization"); assert.equal(denied.creates(), 0);
  const poisoned = await fixture(t); await poisoned.prepare(); await poisoned.owner().tick(); poisoned.poison(); await assert.rejects(poisoned.owner().tick(), /uncertain/); assert.equal(poisoned.starts(), 0); await assert.rejects(poisoned.owner().read(), /reopen/);
  await poisoned.reopen(); assert.equal((await poisoned.owner().tick()).reason, "unknown-start"); assert.equal(poisoned.starts(), 0);
});

test("known nonzero check completion remains failed evidence and never becomes readiness", async (t) => {
  const lab = await fixture(t); await lab.prepare(); await lab.owner().tick(); await lab.owner().tick(); lab.finish(7); const done = await lab.owner().tick(); assert.equal(done.phase, "complete"); assert.equal(done.evidence?.exitCode, 7);
});

test("check descriptions reject scope mismatches and unsupported argv or reserved environment before admission", async (t) => {
  const lab = await fixture(t); const badTarget = { ...lab.target, action: { ...lab.target.action, dataOwner: randomUUID() } };
  assert.equal(describeManagedCheck(lab.application, lab.plan.run, "confirm", badTarget, lab.plan.deadline).ok, false);
  assert.equal(describeManagedCheck(lab.application, lab.plan.run, "missing", lab.target, lab.plan.deadline).ok, false);
  const web = lab.application.services["web"]; assert.ok(web);
  assert.equal(parseManagedApplicationPlan({ ...lab.application, services: { ...lab.application.services, web: { ...web, inputs: { ...web.inputs, environment: { ...web.inputs.environment, KAYRA_OPERATION_ID: { kind: "literal", value: "injected" } } } } } }).ok, false);
  assert.equal(parseManagedApplicationPlan({ ...lab.application, rollout: { ...lab.application.rollout, checks: [{ id: "confirm", service: "web", command: Array.from({ length: 129 }, () => "arg"), timeout_seconds: 2 }] } }).ok, false);
  assert.equal(await lab.journal().read(), undefined);
});

test("mounted checks target declared app containers while retained dependency targets remain refused", async (t) => {
  const lab = await fixture(t); const worker = lab.application.services["worker"]; const database = lab.application.services["db"]; assert.ok(worker); const mount = database?.mounts[0]; assert.ok(mount);
  const inspector = { ...worker, service: "inspector", nativeName: managedServiceName(worker.owner, "inspector"), mounts: [{ ...mount, target: "/shared", readOnly: true }] };
  const checked = parseManagedApplicationPlan({ ...lab.application, services: { ...lab.application.services, inspector }, rollout: { ...lab.application.rollout, services: { ...lab.application.rollout.services, inspector: { role: "worker", overlap: "forbidden" } }, checks: [{ id: "ledger", service: "inspector", command: ["node", "/mounted-check.js"], timeout_seconds: 2 }] } }); assert.ok(checked.ok);
  const target = parseCheckTarget({ ...lab.target, action: { ...lab.target.action, service: "inspector", plan: managedServiceDigest(inspector) } }); assert.ok(target.ok);
  assert.equal(describeManagedCheck(checked.value, lab.plan.run, "ledger", target.value, lab.plan.deadline).ok, true);
  assert.equal(parseManagedApplicationPlan({ ...lab.application, rollout: { ...lab.application.rollout, checks: [{ id: "ledger", service: "db", command: ["node", "/check.js"], timeout_seconds: 2 }] } }).ok, false);
  assert.equal(await lab.journal().read(), undefined);
});
