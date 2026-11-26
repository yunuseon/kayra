/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- drives native fixture effects and records their order */
import { jobPlanDigest } from "../../src/contracts/one-shot-job.ts";
import type { JobCleanupPort } from "../../src/contracts/job-cleanup.ts";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ManagedServiceAction } from "../../src/contracts/managed-swarm-service.ts";
import type { ServiceVersion } from "../../src/contracts/swarm-service.ts";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { indexedForwardFixture } from "./indexed-forward-fixture.ts";
import { preparedForwardFixture } from "./indexed-forward-prepared-fixture.ts";

test("removal owns the lifecycle fence before a competing managed request and preserves the held charge", async (t) => {
  const lab = await indexedForwardFixture(t);
  const before = await lab.index().resourceSnapshot();
  const request = randomUUID();
  const operator = { actor: lab.actor, reason: "Remove the consumer workloads while preserving app-owned data" };
  const proposed = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<boolean>();
  const started = lab.index().requestManagedRemoval("shop", request, operator, {
    now: lab.runtime.now,
    authorize: () => { proposed.resolve(undefined); return release.promise; },
  });
  await proposed.promise;
  const contender = lab.index().requestManagedDeployment("shop", lab.source, lab.runtime);
  const refused = assert.rejects(contender, /removal owns lifecycle/);
  release.resolve(true);
  const removal = await started;
  await refused;
  assert.equal(removal.phase, "requested");
  assert.equal(removal.action, lab.incarnation + ":4");
  assert.deepEqual(removal.volumes, lab.volumes);
  assert.deepEqual(await lab.index().resourceSnapshot(), before);
  assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
  assert.deepEqual(await lab.index().pendingManagedDeployments(), []);
  await assert.rejects(lab.index().cancelManagedDeployment("shop", lab.source.run, lab.runtime), /removal owns lifecycle/);
  await assert.rejects(lab.index().reserveDataVolumeIdentities("shop", ["new"]), /registration has not been verified/);

  const inventory = await lab.index().inspectManagedRemoval("shop", request, lab.ports);
  assert.deepEqual(inventory.services.map((service) => service.name), ["web", "worker", "db"]);
  assert.equal(inventory.services.at(-1)?.plan.role, "retained-dependency");
  assert.deepEqual(inventory.blocked?.state, lab.held);
  assert.deepEqual(inventory.intent.volumes, lab.volumes);
  assert.deepEqual(await lab.index().resourceSnapshot(), before);
  await lab.reopen(); lab.clock(3000);
  const ports = { now: lab.runtime.now, authorize: () => Promise.resolve(false) };
  assert.deepEqual(await lab.index().requestManagedRemoval("shop", request, operator, ports), removal);
  assert.deepEqual(await lab.index().inspectManagedRemoval("shop", request, lab.ports), inventory);
  await assert.rejects(lab.index().requestManagedRemoval("shop", request, { ...operator, reason: "Change the existing accepted removal reason" }, ports), /intent conflicts/);
});

test("removal keeps an interrupted forward reservation with its own newer action", async (t) => {
  const lab = await preparedForwardFixture(t);
  const before = await lab.index().resourceSnapshot();
  const forward = await lab.index().reserveManagedForward("shop", lab.request, lab.candidate, lab.operator, lab.ports);
  const request = randomUUID();
  const operator = { actor: lab.actor, reason: "Remove this app and retain its database and audit evidence" };
  const authorize = () => Promise.resolve(true);
  const removal = await lab.index().requestManagedRemoval("shop", request, operator, { now: lab.runtime.now, authorize });
  assert.deepEqual(removal.interruptedForward, forward);
  assert.equal(removal.action, lab.incarnation + ":5");
  assert.deepEqual(await lab.index().resourceSnapshot(), before);
  const envelope = await lab.readEnvelope();
  assert.equal(envelope.forward, undefined);
  assert.equal(envelope.fence?.lifecycle.phase, "removal-requested");
  assert.equal(envelope.managed?.at(-1)?.completion, null);
  await assert.rejects(lab.index().prepareManagedForwardCleanup("shop", lab.request, lab.ports), /lost its accepted reservation/);
});

test("removal effects stop consumers before retained services and reopen their durable barriers", async (t) => {
  const lab = await indexedForwardFixture(t);
  const request = randomUUID();
  const operator = { actor: lab.actor, reason: "Remove application effects and preserve its owned data volume" };
  const intent = await lab.index().requestManagedRemoval("shop", request, operator, { now: lab.runtime.now, authorize: () => Promise.resolve(true) });
  const priorResources = await lab.index().resourceSnapshot();
  const inventory = await lab.index().inspectManagedRemoval("shop", request, lab.ports);
  const jobArtifact = inventory.jobs[0]; assert.ok(jobArtifact);
  let jobFenced = false;
  const effects: string[] = [];
  const ports = {
    ...lab.artifacts, now: lab.runtime.now,
    services: {
      observe: lab.runtime.services.observe,
      tombstone: (action: ManagedServiceAction, expected: ServiceVersion | null) => {
        effects.push(action.service + ":" + action.effect);
        return lab.runtime.services.tombstone(action, expected);
      },
    },
    jobs: {
      observe: (async (job) => {
        if (jobPlanDigest(job) !== jobArtifact) return lab.runtime.jobs.observe(job);
        return {
          status: "owned", id: (jobFenced ? "f" : "e").repeat(64), barrier: jobFenced, plan: jobArtifact,
          state: jobFenced ? "created" : "running", exitCode: null, probe: null, finishedAt: null,
        };
      }) satisfies JobCleanupPort["observe"],
      fence: ((job, authority, container) => {
        assert.equal(jobPlanDigest(job), jobArtifact);
        assert.equal(authority.action, request);
        assert.equal(container, "e".repeat(64));
        assert.equal(jobFenced, false);
        jobFenced = true;
        effects.push("job:fence");
        return Promise.resolve("acknowledged");
      }) satisfies JobCleanupPort["fence"],
    },
    containers: { observe: () => Promise.reject(new Error("fixture has no pending check")) },
    authorize: (owned: typeof intent) => Promise.resolve(owned.action === intent.action),
  };
  await assert.rejects(lab.index().tickManagedRemovalEffects("shop", request, ports), /not published/);
  const prepared = await lab.index().prepareManagedRemovalEffects("shop", request, ports);
  assert.equal(prepared.phase, "fencing-jobs");
  const tick = () => lab.index().tickManagedRemovalEffects("shop", request, ports);
  for (let i = 0; i < 25 && effects.length < 2; i++) await tick();
  assert.deepEqual(effects, ["job:fence", "web:remove"]);
  await lab.reopen();
  for (let i = 0; i < 75; i++) {
    const state = await tick();
    assert.notEqual(state.phase, "held");
    if (state.phase === "complete") break;
  }
  const state = await lab.index().prepareManagedRemovalEffects("shop", request, ports);
  assert.equal(state.phase, "complete");
  assert.equal(state.deadline, prepared.deadline);
  assert.deepEqual(effects, ["job:fence", "web:remove", "web:scrub", "worker:remove", "worker:scrub", "db:remove", "db:scrub"]);
  assert.deepEqual(await lab.index().resourceSnapshot(), priorResources);
  assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);
  const proof = await lab.index().observeManagedRemovalCompletion("shop", request, ports);
  assert.equal(proof.inventory, state.inventory);
  assert.equal(proof.effects.length, 64);
  const db = lab.services.get("db"); assert.ok(db?.status === "owned");
  lab.services.set("db", { ...db, replicas: 1 });
  try { await assert.rejects(lab.index().observeManagedRemovalCompletion("shop", request, ports), /service or check fence changed/); }
  finally { lab.services.set("db", db); }
  const path = join(lab.selectionDirectory, "..", "..", "removal", request, "state.json");
  await rename(path, path + ".kept");
  try {
    await assert.rejects(lab.index().prepareManagedRemovalEffects("shop", request, ports), /missing|journal|exist/);
    await assert.rejects(readFile(path), /ENOENT/);
  } finally { await rename(path + ".kept", path); }
});
