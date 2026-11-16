/* eslint-disable functional/no-let, functional/prefer-immutable-types -- models journal cuts, clock and run handles */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedVerificationFixture } from "./managed-verification-fixture.ts";
import { parseManagedApplicationPlan, managedApplicationDigest } from "../../src/contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import { parseManagedGroupPreparation } from "../../src/server/deployment/managed-group-preparation.ts";
import { parseManagedConsumerState } from "../../src/server/deployment/managed-consumer-state.ts";
import { parseManagedGroupVerification } from "../../src/server/deployment/managed-group-verification.ts";
import { managedVerificationSnapshot } from "../../src/server/deployment/managed-verification-source.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { managedLifecycleStore, parseManagedLifecycleStore } from "../../src/server/deployment/managed-lifecycle-store.ts";
import { managedReleaseBaselines, parseManagedRelease } from "../../src/server/deployment/managed-release.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fixture = async (t: TestContext) => {
  const data = await managedVerificationFixture(); const parsed = parseManagedApplicationPlan({ ...data.application, rollout: { ...data.application.rollout, migrations: [] } }); assert.ok(parsed.ok); const candidate = parsed.value; const owner = candidate.infrastructure.ownership;
  const source = parseManagedLifecycleSource({ version: 1, run: data.certificate.run, action: data.certificate.action, createdAt: 1000, candidate, previous: null, retained: [], retired: [] });
  const db = candidate.services["db"]; const retained = data.certificate.retained[0]; assert.ok(db && retained);
  const prefix = parseManagedGroupPreparation({ ...owner, run: source.run, action: source.action, plan: managedApplicationDigest(candidate), createdAt: 1000, startupDeadline: 91000, migrationDeadline: 181000, consumerDeadline: 91000, sequencePlan: null, sequence: null, phase: "ready", reason: null,
    nodes: [{ name: "db", plan: managedServiceDigest(db), baseline: null, execution: { version: 1, mode: "apply", createdAt: 1000, action: retained.action, expected: null, phase: "converged", reason: null, verified: { native: retained.native, at: 1000 } }, ready: { action: retained.action, native: retained.native, at: 1000 } }] });
  const consumers = parseManagedConsumerState({ ...data.certificate, plan: managedApplicationDigest(candidate), preparation: hash(prefix) });
  const selected = managedVerificationSnapshot({ kind: "deployment", application: candidate, certificate: consumers });
  const verification = parseManagedGroupVerification({ source: hash(selected.source), ...owner, plan: selected.plan, run: selected.run, checkRun: selected.checkRun, createdAt: selected.createdAt, deadline: selected.deadline, phase: "verified", reason: null, steps: [],
    verified: { at: 1000, observations: selected.witnesses.map((value) => ({ name: value.name, native: value.native, task: value.name.padEnd(25, "t"), routed: candidate.services[value.name]?.role === "http" ? { app: value.action.app, incarnation: value.action.incarnation, service: value.action.service, action: value.action.action, plan: value.action.plan, checkedAt: 1000, status: "ready" } : null })) } });
  const path = await mkdtemp(join(tmpdir(), "kayra-managed-lifecycle-")); const artifacts = await openArtifactStore(join(path, "artifacts")); let journal = await openJournal(path); let clock = 1000; let cut: "before" | "after" | null = null;
  const view = () => ({ read: journal.read, write: async (input: Parameters<typeof journal.write>[0]) => {
    const state = parseManagedLifecycleStore(input); const promoting = state.operation.phase === "settling";
    if (promoting && cut === "before") throw new Error("injected before atomic write"); await journal.write(input); if (promoting && cut === "after") throw new Error("injected lost atomic acknowledgement");
  } });
  const ports = { ...artifacts, now: () => clock }; let store = managedLifecycleStore(view(), owner, ports);
  t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  const converge = async () => { await store.begin(source); await store.admit(); await store.child("preparation", source.run).write(prefix); await store.enter("preparing", "updating", 1000); await store.child("consumers", source.run).write(consumers); await store.enter("updating", "verifying", 1000); };
  return { source, prefix, consumers, verification, artifacts, store: () => store, converge, cut: (value: "before" | "after") => { cut = value; }, clock: (value: number) => { clock = value; },
    reopen: async () => { await journal.close(); journal = await openJournal(path, "existing"); cut = null; store = managedLifecycleStore(view(), owner, ports); },
  };
};

test("final verification and active promotion are one synchronized app write while admission settlement remains pending", async (t) => {
  const lab = await fixture(t); await lab.converge(); assert.equal((await lab.store().read())?.active, null);
  await lab.store().child("verification", lab.source.run).write(lab.verification); const promoted = await lab.store().read(); assert.ok(promoted?.active);
  assert.equal(promoted.operation.phase, "settling"); assert.equal(promoted.operation.verification?.phase, "verified"); assert.equal(promoted.operation.settled, false);
  const record = parseManagedRelease(JSON.parse(await lab.artifacts.read(promoted.active.record))); assert.equal(record.verification.run, lab.source.run);
  await lab.reopen(); assert.deepEqual(await lab.store().read(), promoted); assert.equal((await lab.store().settle()).operation.phase, "complete");
});

for (const cut of ["before", "after"] as const) test(`reopen after ${cut} promotion write never reconstructs a partial active release`, async (t) => {
  const lab = await fixture(t); await lab.converge(); lab.cut(cut); await assert.rejects(lab.store().child("verification", lab.source.run).write(lab.verification), /uncertain/); await assert.rejects(lab.store().read(), /reopen/);
  await lab.reopen(); const state = await lab.store().read(); assert.ok(state);
  assert.equal(state.active !== null, cut === "after"); assert.equal(state.operation.verification !== null, cut === "after"); assert.equal(state.operation.phase, cut === "after" ? "settling" : "verifying");
});

test("cancellation can be persisted between child effects and prevents a late verification from promoting", async (t) => {
  const lab = await fixture(t); await lab.converge(); await lab.store().cancel(); await lab.store().child("verification", lab.source.run).write(lab.verification); const state = await lab.store().read(); assert.ok(state);
  assert.equal(state.operation.phase, "held"); assert.equal(state.operation.reason, "cancellation"); assert.equal(state.operation.verification?.phase, "verified"); assert.equal(state.active, null); assert.equal((await lab.store().settle()).operation.settled, false);
});

test("stale routed evidence requests fresh verification without rerunning checks or minting another deadline", async (t) => {
  const lab = await fixture(t); await lab.converge(); lab.clock(4001); await lab.store().child("verification", lab.source.run).write(lab.verification); const state = await lab.store().read(); assert.ok(state);
  assert.equal(state.active, null); assert.equal(state.operation.phase, "verifying"); assert.equal(state.operation.verification?.phase, "running"); assert.equal(state.operation.verification.deadline, lab.verification.deadline);
});

test("expired final verification remains historical evidence without promotion", async (t) => {
  const lab = await fixture(t); await lab.converge(); lab.clock(lab.verification.deadline); await lab.store().child("verification", lab.source.run).write(lab.verification); const state = await lab.store().read(); assert.ok(state);
  assert.equal(state.active, null); assert.equal(state.operation.phase, "held"); assert.equal(state.operation.reason, "deadline");
});

test("a newer operation requires the verified active record and rejects every obsolete child view", async (t) => {
  const lab = await fixture(t); await lab.converge(); const old = lab.store().child("verification", lab.source.run); await old.write(lab.verification); await lab.store().settle(); const state = await lab.store().read(); assert.ok(state?.active);
  const release = parseManagedRelease(JSON.parse(await lab.artifacts.read(state.active.record))); const baseline = managedReleaseBaselines(release).find((value) => value.name === "db"); assert.ok(baseline);
  const next = parseManagedLifecycleSource({ ...lab.source, run: randomUUID(), action: lab.source.candidate.infrastructure.ownership.incarnation + ":3", previous: release, retained: [{ ...baseline, kind: "active" }] });
  const prepared = await lab.store().begin(next); assert.equal(prepared.sequence, 3); assert.equal(prepared.active?.record, state.active.record); assert.ok(prepared.history);
  await assert.rejects(old.read(), /operation ownership/); await assert.rejects(old.write(lab.verification), /operation ownership/);
});
