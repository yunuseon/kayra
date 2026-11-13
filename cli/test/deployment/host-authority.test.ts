/* eslint-disable functional/no-let, functional/prefer-immutable-types -- models host observations and test runtimes */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fixture, template } from "./http-test-fixture.ts";
import { recoveryFixture } from "./http-recovery-fixture.ts";
import { sequenceFixture } from "./migration-sequence-fixture.ts";
import { completePorts } from "./rollout-plan-fixture.ts";
import { parseLifecycleEnvelope } from "../../src/server/deployment/lifecycle-envelope.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { httpExecution } from "../../src/server/deployment/http-execution.ts";
import { rolloutExecution } from "../../src/server/deployment/rollout-execution.ts";

const jobFixture = async (t: TestContext) => {
  const lab = await recoveryFixture(t); const jobs = await sequenceFixture(t); jobs.now(lab.ports.now()); let available = true;
  const ports = { ...lab.ports, ...lab.artifacts, jobs: jobs.ports.native, materialize: () => Promise.resolve({ RELEASE: "A", TOKEN: "private-value" }),
    observeHost: (host: Parameters<typeof lab.ports.observeHost>[0]) => available ? lab.ports.observeHost(host) : Promise.resolve({ status: "unavailable" as const }) };
  await lab.index.prepareBuild("shop", "b".repeat(40), lab.builds);
  const parent = await lab.index.prepareRollout("shop", randomUUID(), "b".repeat(40), completePorts(ports));
  await lab.index.admitRollout("shop", parent.ticket, ports);
  const drive = async (owner: ReturnType<typeof rolloutExecution>, expected: string) => {
    for (let count = 0; count < 100; count++) if (await owner.tick("shop", parent.preparation.run) === expected) return;
    throw new Error("expected rollout phase was not reached");
  };
  return { ...lab, jobs, parent, ports, drive, available: (value: boolean) => { available = value; } };
};

test("a preserved resource decision cannot admit its app marker without matching current host facts", async (t) => {
  const lab = await fixture(t); const ports = completePorts(lab.ports); await lab.index.prepareBuild("shop", "a".repeat(40), lab.builds);
  const parent = await lab.index.prepareRollout("shop", randomUUID(), "a".repeat(40), ports); await lab.index.admitRollout("shop", parent.ticket, ports); await lab.index.close();
  const path = join(lab.path, createHash("sha256").update("shop").digest("hex"), "state.json"); const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  const checked = parseLifecycleEnvelope(raw); assert.ok(checked.ok); assert.ok(checked.value.rollout);
  await writeFile(path, JSON.stringify({ ...checked.value, rollout: { ...checked.value.rollout, admitted: false } }));
  const index = await openLifecycleAppIndex(lab.path); t.after(() => index.close());
  await assert.rejects(index.admitRollout("shop", parent.ticket, { ...ports, observeHost: () => Promise.resolve({ status: "unavailable" }) }), /current resource host/);
  const ready = await ports.observeHost(template.host); assert.equal(ready.status, "ready");
  await assert.rejects(index.admitRollout("shop", parent.ticket, { ...ports, observeHost: () => Promise.resolve({ ...ready, node: "z".repeat(25) }) }), /current resource host/);
  assert.equal((await index.rolloutOperation("shop", parent.preparation.run))?.admitted, false);
  assert.equal((await index.resourceSnapshot())?.charges[0]?.result, "pending");
  const admitted = await index.admitRollout("shop", parent.ticket, { ...ports, now: () => parent.admissionDeadline + 1 }); assert.equal(admitted?.admitted, true);
  assert.equal((await index.resourceSnapshot())?.charges[0]?.deadline, parent.admissionDeadline);
});

test("host authority loss prevents migration Create despite an earlier valid reservation", async (t) => {
  const lab = await jobFixture(t); lab.available(false); const owner = rolloutExecution(lab.index, lab.ports); await lab.drive(owner, "held");
  assert.equal([...lab.jobs.nodes.values()].some((job) => job.calls.some((call) => call.method === "POST")), false);
  assert.equal([...lab.jobs.nodes.values()].reduce((sum, job) => sum + job.executions(), 0), 0);
  assert.equal(lab.writes(), 1); assert.equal((await lab.index.resourceSnapshot())?.charges[0]?.result, "pending");
});

test("host authority is checked again between migration Create and Start", async (t) => {
  const lab = await jobFixture(t); const owner = rolloutExecution(lab.index, { ...lab.ports, jobs: { ...lab.ports.jobs,
    create: async (...args: Readonly<Parameters<typeof lab.ports.jobs.create>>) => { const result = await lab.ports.jobs.create(...args); lab.available(false); return result; } } });
  await lab.drive(owner, "held"); assert.ok([...lab.jobs.nodes.values()].some((job) => job.calls.some((call) => call.path.startsWith("/containers/create"))));
  assert.equal([...lab.jobs.nodes.values()].reduce((sum, job) => sum + job.executions(), 0), 0); assert.equal(lab.writes(), 1);
});

test("owned job fencing remains possible after host readiness loss, while HTTP handoff stays blocked", async (t) => {
  const lab = await jobFixture(t); const owner = rolloutExecution(lab.index, { ...lab.ports, jobs: { ...lab.ports.jobs,
    start: async (...args: Readonly<Parameters<typeof lab.ports.jobs.start>>) => { const result = await lab.ports.jobs.start(...args); lab.available(false); return result; } } });
  await lab.drive(owner, "ready"); const state = await lab.index.rolloutOperation("shop", lab.parent.preparation.run);
  assert.equal(state?.preparation.sequence?.steps[0]?.attempts[0]?.execution?.phase, "complete");
  assert.equal([...lab.jobs.nodes.values()].reduce((sum, job) => sum + job.executions(), 0), 1);
  await assert.rejects(lab.index.handoffRollout("shop", lab.parent.preparation.run, lab.ports), /current resource host/);
  assert.equal(await lab.index.httpOperation("shop", lab.parent.preparation.run), undefined); assert.equal(lab.writes(), 1);
  lab.available(true); assert.equal((await lab.index.handoffRollout("shop", lab.parent.preparation.run, lab.ports)).phase, "admitted");
});

test("HTTP replacement and promotion require current host facts without refreshing their deadline", async (t) => {
  const lab = await recoveryFixture(t); const b = await lab.start("b".repeat(40)); let available = true;
  const owner = httpExecution(lab.index, { ...lab.ports, observeHost: (host) => available ? lab.ports.observeHost(host) : Promise.resolve({ status: "unavailable" }) });
  assert.equal(await owner.tick("shop", b.request), "admitted"); assert.equal(await owner.tick("shop", b.request), "applying");
  available = false; assert.equal(await owner.tick("shop", b.request), "runtime-unavailable"); assert.equal(lab.writes(), 1);
  available = true; assert.equal(await owner.tick("shop", b.request), "verifying"); assert.equal(lab.writes(), 2);
  available = false; assert.equal(await owner.tick("shop", b.request), "runtime-unavailable");
  assert.equal((await lab.index.deploymentStatus("shop")).verifiedActive?.plan, lab.initial.plan);
  assert.equal((await lab.index.httpOperation("shop", b.request))?.deadline, b.deadline);
  available = true; assert.equal(await owner.tick("shop", b.request), "succeeded"); assert.equal(lab.writes(), 2);
});

test("HTTP restoration cannot start another task until current host authority is ready", async (t) => {
  const lab = await recoveryFixture(t); const b = await lab.start("b".repeat(40)); let available = true;
  const owner = httpExecution(lab.index, { ...lab.ports, observeHost: (host) => available ? lab.ports.observeHost(host) : Promise.resolve({ status: "unavailable" }) });
  for (const expected of ["admitted", "applying", "verifying"]) assert.equal(await owner.tick("shop", b.request), expected);
  await lab.index.cancelHttpRollout("shop", b.request, 3000); lab.now(3000); available = false;
  assert.equal(await owner.tick("shop", b.request), "runtime-unavailable"); assert.equal(lab.writes(), 2);
  const deadline = (await lab.index.httpOperation("shop", b.request))?.recoveryDeadline;
  available = true; for (let count = 0; count < 10; count++) if (await owner.tick("shop", b.request) === "cancelled") break;
  assert.equal((await lab.index.httpOperation("shop", b.request))?.phase, "cancelled");
  assert.equal((await lab.index.httpOperation("shop", b.request))?.recoveryDeadline, deadline); assert.equal(lab.writes(), 3);
});
