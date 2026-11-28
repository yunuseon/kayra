/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- models CAS races and interrupted runtime acknowledgements */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedApplicationPlan, managedApplicationDigest } from "../../src/contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import type { ManagedServiceScope } from "../../src/contracts/managed-swarm-service.ts";
import type { ManagedServiceAction } from "../../src/contracts/managed-swarm-service.ts";
import type { ServiceObservation } from "../../src/contracts/swarm-service.ts";
import { managedServiceCompensation } from "../../src/server/deployment/managed-service-compensation.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";

const fixture = async (t: TestContext, cleanup: boolean | "new-only" = false, quiesce = false, retained = false) => {
  const data = await managedPlanFixture(); const web = data.plan.services["web"]; assert.ok(web);
  const checked = parseManagedApplicationPlan({ ...data.plan, services: { ...data.plan.services, web: { ...web, command: ["candidate"] } } }); assert.ok(checked.ok); const candidate = checked.value;
  const previous = cleanup === "new-only" ? (() => {
    const parsed = parseManagedApplicationPlan({ ...data.plan, routes: [], services: Object.fromEntries(Object.entries(data.plan.services).filter(([name]) => name !== "web")), rollout: { ...data.plan.rollout, migrations: [], services: Object.fromEntries(Object.entries(data.plan.rollout.services).filter(([name]) => name !== "web")) } }); assert.ok(parsed.ok); return parsed.value;
  })() : cleanup ? null : data.plan; const service = cleanup ? candidate.services["web"] : previous?.services["web"]; assert.ok(service);
  // A worker can switch overlap policy; HTTP is always start-first and must never be quiesced for restoration.
  const selected = retained ? "db" : quiesce ? "worker" : "web";
  const oldSpec = previous?.services[selected]; const nextSpec = candidate.services[selected]; assert.ok(nextSpec);
  const old = quiesce && previous !== null ? (() => { const worker = previous.services["worker"]; assert.ok(worker); const parsed = parseManagedApplicationPlan({ ...previous, rollout: { ...previous.rollout, services: { ...previous.rollout.services, worker: { role: "worker", overlap: "allowed" } } }, services: { ...previous.services, worker: { ...worker, overlap: "allowed" } } }); assert.ok(parsed.ok); return parsed.value; })() : previous;
  const target = old?.services[selected] ?? nextSpec;
  const path = await mkdtemp(join(tmpdir(), "kayra-compensate-")); const artifacts = await openArtifactStore(join(path, "artifacts"));
  let journal = await openJournal(path); let clock = 1000; let lost = false; let conflict = false; let admitted = true; let updating = false; let uncertainFenceWrite = false;
  const action: ManagedServiceAction = { app: target.owner.app, incarnation: target.owner.incarnation, dataOwner: target.owner.dataOwner, service: selected, action: target.owner.incarnation + ":2", plan: managedServiceDigest(target), effect: "restore", deadline: 91000 };
  const native = { id: "s".repeat(25), version: 2 }; const writes: ManagedServiceAction[] = [];
  const observedFor = (action: ManagedServiceAction, version: number) => ({ status: "owned" as const, id: native.id, version, action: action.action, effect: action.effect, taskEffect: action.effect, plan: action.plan, taskPlan: action.plan, specMatches: true, tombstone: false, containersConverged: true, containersStopped: true, retainedInputsCleared: false, replicas: 1, endpoint: "vip" as const, update: updating ? "updating" as const : "completed" as const,
    tasks: [{ id: "t".repeat(25), incarnation: action.incarnation, action: action.action, plan: action.plan, effect: action.effect, desired: "running" as const, state: "running" as const, health: "healthy" as const }] });
  let observed: ServiceObservation = observedFor({ ...action, plan: managedServiceDigest(nextSpec), effect: "apply" }, 2);
  const ports = { ...artifacts, now: () => clock, authorize: () => Promise.resolve(admitted), services: {
    observe: (scope: ManagedServiceScope) => { assert.deepEqual(Object.keys(scope).toSorted(), ["app", "dataOwner", "incarnation", "service"]); return Promise.resolve(observed); },
    observeDesired: (action: ManagedServiceAction) => Promise.resolve(observed.status === "owned" ? { ...observed, specMatches: observed.plan === action.plan } : observed),
    apply: (request: ManagedServiceAction, expected: unknown, _spec: unknown, context: ManagedApplicationPlan) => {
      assert.equal(managedApplicationDigest(context), old === null ? null : managedApplicationDigest(old));
      assert.ok(observed.status === "owned"); assert.deepEqual(expected, { id: observed.id, version: observed.version }); writes.push(request);
      if (conflict) { conflict = false; observed = { ...observed, version: observed.version + 1 }; return Promise.resolve("conflict" as const); }
      observed = observedFor(request, observed.version + 1); return lost ? Promise.reject(new Error("lost restore acknowledgement")) : Promise.resolve("acknowledged" as const);
    },
    fence: (request: ManagedServiceAction, expected: unknown) => {
      assert.ok(observed.status === "owned"); assert.deepEqual(expected, { id: observed.id, version: observed.version }); writes.push(request);
      observed = { ...observed, version: observed.version + 1, action: request.action, effect: "fence" }; return Promise.resolve("acknowledged" as const);
    },
    tombstone: (request: ManagedServiceAction, expected: unknown) => {
      assert.ok(observed.status === "owned"); assert.deepEqual(expected, { id: observed.id, version: observed.version }); writes.push(request);
      observed = { ...observed, version: observed.version + 1, action: request.action, plan: request.plan, effect: request.effect, taskEffect: request.effect, tombstone: true, containersConverged: true, containersStopped: true, retainedInputsCleared: request.effect === "scrub", replicas: 0, endpoint: "dnsrr", tasks: [] }; return Promise.resolve("acknowledged" as const);
    },
  } };
  const view = () => ({ read: journal.read, write: async (value: Parameters<typeof journal.write>[0]) => { await journal.write(value);
    if (uncertainFenceWrite && typeof value === "object" && value !== null && !Array.isArray(value) && "fences" in value && Array.isArray(value["fences"]) && value["fences"].length > 0) throw new Error("lost synchronized fence intent acknowledgement");
  } });
  let owner = managedServiceCompensation(view(), ports);
  t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  const drive = async () => { for (let i = 0; i < 80; i++) { const state = await owner.tick(); if (state.phase !== "recovering") return state; } throw new Error("compensation did not settle"); };
  return { candidate, previous: old, action, native, oldSpec, writes, ports, path, observedFor, owner: () => owner, journal: () => journal, drive,
    prepare: () => owner.prepare(candidate, old, action, cleanup ? null : { ...native, version: 1 }, [native]), lost: () => { lost = true; }, conflict: () => { conflict = true; }, updating: () => { updating = true; }, deny: () => { admitted = false; }, now: (value: number) => { clock = value; },
    uncertainFenceWrite: () => { uncertainFenceWrite = true; },
    observe: (value: ServiceObservation) => { observed = value; }, observed: () => observed,
    reopen: async () => { await journal.close(); journal = await openJournal(path, "existing"); uncertainFenceWrite = false; owner = managedServiceCompensation(view(), ports); },
  };
};

test("HTTP compensation restores the immutable previous context without a zero-replica barrier and survives lost acknowledgement", async (t) => {
  const lab = await fixture(t); await lab.prepare(); lab.lost();
  for (let i = 0; i < 4 && lab.writes.length === 0; i++) await lab.owner().tick();
  assert.equal(lab.writes.length, 1); await lab.reopen(); const done = await lab.drive(); assert.equal(done.phase, "complete");
  assert.deepEqual(lab.writes.map((action) => action.effect), ["restore"]); assert.ok((done.proof?.native.version ?? 0) > lab.native.version);
  lab.now(999999); assert.deepEqual(await lab.owner().tick(), done);
});

for (const cut of ["before", "after"] as const) test(`SIGKILL ${cut} the restore effect honors recorded native state and deadline`, { timeout: 15_000 }, async (t) => {
  const lab = await fixture(t);
  await lab.prepare();
  const observed = lab.observed();
  assert.ok(observed.status === "owned");
  await lab.journal().close();
  const code = `
    import { strict as assert } from "node:assert";
    import { open } from "node:fs/promises";
    import { join } from "node:path";
    import { openJournal } from ${JSON.stringify(new URL("../../src/server/deployment/journal.ts", import.meta.url).href)};
    import { openArtifactStore } from ${JSON.stringify(new URL("../../src/server/deployment/artifact-store.ts", import.meta.url).href)};
    import { managedServiceCompensation } from ${JSON.stringify(new URL("../../src/server/deployment/managed-service-compensation.ts", import.meta.url).href)};
    const [path, cut, native] = process.argv.slice(1);
    const observed = JSON.parse(native);
    const journal = await openJournal(path, "existing");
    const artifacts = await openArtifactStore(join(path, "artifacts"));
    const kill = () => process.kill(process.pid, "SIGKILL");
    const unreachable = () => Promise.reject(new Error("unexpected restore runtime effect"));
    const owner = managedServiceCompensation(journal, { ...artifacts, now: () => 1000, authorize: async () => true, services: {
      observe: async () => observed,
      observeDesired: async (request) => ({ ...observed, specMatches: observed.plan === request.plan }),
      fence: unreachable,
      tombstone: unreachable,
      apply: async (request, expected) => {
        assert.deepEqual(expected, { id: observed.id, version: observed.version });
        assert.equal(request.effect, "restore");
        if (cut === "before") kill();
        const result = { ...observed, version: observed.version + 1,
          action: request.action, effect: request.effect, taskEffect: request.effect, plan: request.plan, taskPlan: request.plan,
          tasks: observed.tasks.map((task) => ({ ...task, action: request.action, plan: request.plan, effect: request.effect })),
        };
        const file = await open(join(path, "observed-restore.json"), "wx", 0o600);
        try { await file.writeFile(JSON.stringify(result)); await file.sync(); } finally { await file.close(); }
        kill();
      },
    } });
    for (let i = 0; i < 6; i++) await owner.tick();
    throw new Error("rollback failed to reach the process cut");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, lab.path, cut, JSON.stringify(observed)], { stdio: ["ignore", "ignore", "inherit"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  assert.deepEqual(await once(child, "exit"), [null, "SIGKILL"]);
  const nativePath = join(lab.path, "observed-restore.json");
  if (cut === "after") {
    const restored = lab.observedFor({ ...lab.action, action: lab.action.action + ":restore:1" }, observed.version + 1);
    assert.deepEqual(JSON.parse(await readFile(nativePath, "utf8")), restored);
    lab.observe(restored);
  } else {
    await assert.rejects(readFile(nativePath), { code: "ENOENT" });
  }
  await lab.reopen();
  const pending = await lab.owner().read();
  assert.equal(pending?.action.deadline, lab.action.deadline);
  assert.equal(pending.attempts[0]?.phase, "observing");
  const done = await lab.drive();
  assert.equal(done.phase, "complete");
  assert.equal(done.action.deadline, lab.action.deadline);
  assert.deepEqual(lab.writes.map((write) => write.effect), cut === "before" ? ["fence", "restore"] : []);
});

test("a fresh restore CAS attempt follows a recorded version conflict without replaying its identity", async (t) => {
  const lab = await fixture(t); await lab.prepare(); lab.conflict(); assert.equal((await lab.drive()).phase, "complete");
  assert.equal(lab.writes.length, 2); assert.ok(lab.writes[0]?.action.endsWith(":restore:1")); assert.ok(lab.writes[1]?.action.endsWith(":restore:2"));
  assert.deepEqual((await lab.owner().read())?.attempts.map((attempt) => attempt.expected?.version), [2, 3]);
});

test("an accepted restoring template waits for convergence without creating another update", async (t) => {
  const lab = await fixture(t); await lab.prepare(); lab.updating();
  for (let i = 0; i < 8; i++) await lab.owner().tick(); assert.equal(lab.writes.length, 1);
  await lab.reopen(); for (let i = 0; i < 3; i++) await lab.owner().tick(); assert.equal(lab.writes.length, 1);
  const observed = lab.observed(); assert.ok(observed.status === "owned"); lab.observe({ ...observed, update: "completed" }); assert.equal((await lab.drive()).phase, "complete");
});

test("failed initial workloads are drained and scrubbed without deleting services or volumes", async (t) => {
  const lab = await fixture(t, true); await lab.prepare(); const done = await lab.drive(); assert.equal(done.phase, "complete");
  assert.deepEqual(lab.writes.map((action) => action.effect), ["remove", "scrub"]); const observed = lab.observed(); assert.ok(observed.status === "owned"); assert.equal(observed.retainedInputsCleared, true);
});

test("a forbidden-overlap candidate is quiesced before restoring a previously allowed worker", async (t) => {
  const lab = await fixture(t, false, true); await lab.prepare(); assert.equal((await lab.drive()).phase, "complete");
  assert.deepEqual(lab.writes.map((action) => action.effect), ["remove", "scrub", "restore"]);
});

test("expiry and authorization denial preserve evidence without a speculative restoration", async (t) => {
  const lab = await fixture(t); await lab.prepare(); lab.deny(); assert.equal((await lab.drive()).phase, "held"); assert.equal(lab.writes.length, 0);
  const expired = await fixture(t); await expired.prepare(); await expired.reopen(); expired.now(expired.action.deadline); assert.equal((await expired.owner().tick()).reason, "deadline"); assert.equal(expired.writes.length, 0);
});

test("a missing or replaced previously verified service holds instead of creating a new native identity", async (t) => {
  const lab = await fixture(t); await lab.prepare(); lab.observe({ status: "absent" }); assert.equal((await lab.drive()).phase, "held"); assert.equal(lab.writes.length, 0);
  const replacement = await fixture(t); await replacement.prepare(); const observed = replacement.observed(); assert.ok(observed.status === "owned"); replacement.observe({ ...observed, id: "x".repeat(25) }); assert.equal((await replacement.drive()).phase, "held"); assert.equal(replacement.writes.length, 0);
});

test("restart before restore dispatch fences the uncertain CAS before a fresh restore identity", async (t) => {
  const lab = await fixture(t); await lab.prepare(); await lab.owner().tick(); const state = await lab.owner().read(); assert.ok(state);
  const attempt = state.attempts[0]; assert.ok(attempt); await lab.journal().write({ ...state, attempts: [{ ...attempt, phase: "observing" }] });
  await lab.reopen(); const done = await lab.drive(); assert.equal(done.phase, "complete");
  assert.deepEqual(lab.writes.map((action) => action.effect), ["fence", "restore"]); assert.ok(lab.writes[1]?.action.endsWith(":restore:2"));
  assert.ok((done.proof?.native.version ?? 0) > (done.fences[0]?.expected.version ?? Infinity));
});

test("restart before metadata fence dispatch uses bounded fresh identities without changing the task template", async (t) => {
  const lab = await fixture(t); await lab.prepare(); await lab.owner().tick(); const state = await lab.owner().read(); assert.ok(state);
  const attempt = state.attempts[0]; assert.ok(attempt); await lab.journal().write({ ...state, attempts: [{ ...attempt, phase: "observing" }], fences: [{ expected: lab.native }] });
  await lab.reopen(); const done = await lab.drive(); assert.equal(done.phase, "complete");
  assert.ok(lab.writes[0]?.action.endsWith(":fence:2")); assert.equal(done.fences.length, 2); assert.equal(lab.writes.filter((action) => action.effect === "restore").length, 1);
});

test("a new-only consumer is scrubbed even when a previous application release exists", async (t) => {
  const lab = await fixture(t, "new-only"); await lab.prepare(); const done = await lab.drive(); assert.equal(done.phase, "complete"); assert.notEqual(done.previous, null);
  assert.deepEqual(lab.writes.map((action) => action.effect), ["remove", "scrub"]);
});

test("failed initial retained workloads can be scrubbed while their owned volumes remain outside cleanup authority", async (t) => {
  const lab = await fixture(t, true, false, true); await lab.prepare(); const done = await lab.drive(); assert.equal(done.phase, "complete");
  assert.deepEqual(lab.writes.map((action) => action.effect), ["remove", "scrub"]); assert.equal(done.proof?.native.id, lab.native.id);
});

test("uncertain fence persistence poisons the writer and reopening settles its recorded CAS evidence", async (t) => {
  const lab = await fixture(t); await lab.prepare(); await lab.owner().tick(); const state = await lab.owner().read(); assert.ok(state); const attempt = state.attempts[0]; assert.ok(attempt);
  await lab.journal().write({ ...state, attempts: [{ ...attempt, phase: "observing" }] }); await lab.reopen(); lab.uncertainFenceWrite();
  await assert.rejects(lab.owner().tick(), /uncertain/); assert.equal(lab.writes.length, 0); await assert.rejects(lab.owner().read(), /reopen/);
  await lab.reopen(); const done = await lab.drive(); assert.equal(done.phase, "complete"); assert.equal(done.fences.length, 2); assert.equal(lab.writes.length, 2);
});
