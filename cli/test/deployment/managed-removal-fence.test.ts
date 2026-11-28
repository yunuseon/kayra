/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- drives native fixture effects and records their order */
import { managedReceipt } from "../../src/server/deployment/managed-receipt.ts";
import { managedRemovalRuntime } from "../../src/server/composition/managed-removal-runtime.ts";
import { jobPlanDigest } from "../../src/contracts/one-shot-job.ts";
import type { JobCleanupPort } from "../../src/contracts/job-cleanup.ts";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ManagedServiceAction } from "../../src/contracts/managed-swarm-service.ts";
import type { ServiceVersion } from "../../src/contracts/swarm-service.ts";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { managedIndexFixture } from "./managed-index-fixture.ts";
import { indexedForwardFixture } from "./indexed-forward-fixture.ts";
import { parseLifecycleEnvelope } from "../../src/server/deployment/lifecycle-envelope.ts";
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
  assert.deepEqual(await lab.index().managedPruneCandidates(), ["shop"]);
  const pending = await lab.index().publishedDeploymentStatus("shop");
  assert.equal(pending?.version, 1);
  assert.equal(pending.retirement?.phase, "requested");
  assert.equal(pending.verifiedActive, null);
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
  const ports = managedRemovalRuntime(inventory, {
    ...lab.artifacts, now: lab.runtime.now,
    native: {
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
    },
    authorize: (owned) => Promise.resolve(owned.action === intent.action),
  });
  const web = inventory.services.find((item) => item.name === "web"); assert.ok(web);
  const scope = { app: intent.owner.app, incarnation: intent.owner.incarnation, dataOwner: intent.owner.dataOwner, service: "web" };
  const service = { ...scope, action: intent.action + ":remove:1", effect: "remove" as const, plan: web.digest, deadline: intent.createdAt + 90_000 };
  assert.deepEqual(await ports.services.observe({ ...scope, service: "unrelated" }), { status: "foreign" });
  assert.equal(await ports.services.tombstone({ ...service, action: intent.action + ":apply:1", effect: "apply" }, null, web.plan.image), "refused");
  assert.equal(await ports.services.tombstone(service, null, "unrelated"), "refused");
  assert.equal(await ports.services.tombstone({ ...service, deadline: intent.createdAt }, null, web.plan.image), "refused");
  assert.deepEqual(effects, []);
  await assert.rejects(lab.index().tickManagedRemovalEffects("shop", request, ports), /not published/);
  const withdrawal = { version: 1, status: "withdrawn", request, action: intent.action, registration: intent.registration, observedAt: lab.runtime.now() };
  const finalize = (observed: unknown = withdrawal) => lab.index().completeManagedRemoval("shop", request, {
    ...ports, observeWithdrawal: () => Promise.resolve(observed),
  });
  const retire = () => lab.index().retireManagedRemovalAccounting("shop", request, ports);
  const prepared = await lab.index().prepareManagedRemovalEffects("shop", request, ports);
  assert.equal(prepared.phase, "fencing-jobs");
  await assert.rejects(finalize(), /lacks complete effects/);
  await assert.rejects(retire, /lacks complete effects/);
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
  try {
    await assert.rejects(lab.index().observeManagedRemovalCompletion("shop", request, ports), /service or check fence changed/);
    await assert.rejects(retire, /service or check fence changed/);
    assert.deepEqual(await lab.index().resourceSnapshot(), priorResources);
  }
  finally { lab.services.set("db", db); }
  lab.cut("removal-accounting-after");
  await assert.rejects(retire, /injected after removal-accounting/);
  assert.deepEqual(await lab.index().resourceSnapshot(), priorResources);
  await lab.reopen();
  const envelope = parseLifecycleEnvelope(JSON.parse(await readFile(join(lab.selectionDirectory, "..", "..", "..", "state.json"), "utf8")));
  assert.ok(envelope.ok);
  const receipt = envelope.value.removalAccounting; assert.ok(receipt);
  assert.equal(receipt.effects, proof.effects);
  assert.notEqual(receipt.before, receipt.after);

  await assert.rejects(finalize(), /awaits accounting/);
  lab.cut("removal-retirement-before");
  await assert.rejects(retire, /injected before removal-retirement/);
  assert.deepEqual(await lab.index().resourceSnapshot(), priorResources);
  await lab.reopen();
  lab.cut("removal-retirement-after");
  await assert.rejects(retire, /injected after removal-retirement/);
  await lab.reopen();
  assert.deepEqual(await lab.index().retireManagedRemovalAccounting("shop", request, { ...ports, authorize: () => Promise.resolve(false) }), receipt);
  const previous = priorResources?.charges.find((charge) => charge.app === "shop"); assert.ok(previous);
  assert.deepEqual((await lab.index().resourceSnapshot())?.charges.find((charge) => charge.app === "shop"), { ...previous, result: "absent" });
  assert.deepEqual(await lab.index().managedState("shop", lab.runtime), lab.held);

  const path = join(lab.selectionDirectory, "..", "..", "removal", request, "state.json");
  await rename(path, path + ".kept");
  try {
    await assert.rejects(lab.index().prepareManagedRemovalEffects("shop", request, ports), /missing|journal|exist/);
    await assert.rejects(readFile(path), /ENOENT/);
    const blocked = await lab.index().publishedDeploymentStatus("shop");
    assert.equal(blocked?.version, 1);
    assert.equal(blocked.retirement?.reason, "evidence");
    assert.equal(blocked.requiredAction, "inspect-and-resolve");
  } finally { await rename(path + ".kept", path); }

  await assert.rejects(finalize({ ...withdrawal, request: randomUUID() }), /withdrawal is unverified/);
  assert.equal(await lab.index().managedRemovalTombstone("shop"), undefined);
  assert.equal((await lab.index().managedDeploymentStatus("shop", lab.runtime))?.operation.phase, "held");

  lab.cut("removal-tombstone-after");
  await assert.rejects(finalize(), /injected after removal-tombstone/);
  await lab.reopen();
  const tombstone = await finalize({ status: "unavailable" });
  assert.equal(tombstone.checkpoint, inventory.checkpoint);
  const recorded = await lab.index().managedRemovalTombstone("shop"); assert.ok(recorded);
  assert.deepEqual(recorded.volumes, intent.volumes);
  assert.deepEqual(recorded.owner, intent.owner);
  const removed = parseLifecycleEnvelope(JSON.parse(await readFile(join(lab.selectionDirectory, "..", "..", "..", "state.json"), "utf8")));
  assert.ok(removed.ok);
  assert.equal(removed.value.fence?.lifecycle.phase, "removed");
  assert.deepEqual(removed.value.operations, []);
  assert.deepEqual(removed.value.managed?.at(-1)?.completion, {
    outcome: "removed", disposition: "cancelled", rootSnapshot: inventory.checkpoint, removal: request,
  });
  const archived = await lab.index().acceptedManagedRequest("shop", lab.source.run, lab.runtime); assert.ok(archived);
  assert.equal(managedReceipt(archived.source, archived.request).outcome, "removed");
  assert.equal(await lab.index().managedDeploymentStatus("shop", lab.runtime), null);
  const published = await lab.index().publishedDeploymentStatus("shop");
  assert.equal(published?.version, 1);
  assert.equal(published.lifecycle, "removed");
  assert.equal(published.retirement?.remainingVolumes, intent.volumes.length);
  assert.deepEqual(await lab.index().managedHealthContexts(lab.runtime), []);
  assert.deepEqual(await lab.index().managedPruneCandidates(), []);
  assert.deepEqual(await lab.index().pendingManagedDeployments(), []);
  await assert.rejects(lab.index().verifiedRegistration("shop"), /registration has not been verified/);
});

test("SIGKILL around removal publication preserves the tombstone, data identities and accounting", { timeout: 15_000 }, async (t) => {
  const lab = await managedIndexFixture(t);
  const request = randomUUID();
  const authorize = () => Promise.resolve(true);
  const intent = await lab.index().requestManagedRemoval("shop", request, {
    actor: { kind: "operator-control", identity: "fixture-operator" }, reason: "Remove the unused registration while retaining its data ownership",
  }, { now: lab.runtime.now, authorize });
  const inventory = await lab.index().inspectManagedRemoval("shop", request, lab.runtime);
  assert.deepEqual(inventory.services, []);
  assert.equal(inventory.checkpoint, null);
  const unreachable = () => Promise.reject(new Error("unused app cannot dispatch native effects"));
  const ports = managedRemovalRuntime(inventory, {
    ...lab.artifacts, now: lab.runtime.now, authorize,
    native: { services: { observe: unreachable, tombstone: unreachable }, jobs: { observe: unreachable, fence: unreachable },
      containers: { observe: unreachable } },
  });
  await lab.index().prepareManagedRemovalEffects("shop", request, ports);
  assert.equal((await lab.index().tickManagedRemovalEffects("shop", request, ports)).phase, "stopping");
  assert.equal((await lab.index().tickManagedRemovalEffects("shop", request, ports)).phase, "complete");
  const retirement = await lab.index().retireManagedRemovalAccounting("shop", request, ports);
  assert.equal(retirement.before, retirement.after);
  assert.equal(await lab.index().resourceSnapshot(), null);
  const code = `
    import { dirname, join } from "node:path";
    import { openJournal } from ${JSON.stringify(new URL("../../src/server/deployment/journal.ts", import.meta.url).href)};
    import { openArtifactStore } from ${JSON.stringify(new URL("../../src/server/deployment/artifact-store.ts", import.meta.url).href)};
    import { openLifecycleAppIndex } from ${JSON.stringify(new URL("../../src/server/deployment/lifecycle-app-index.ts", import.meta.url).href)};
    import { managedRemovalRuntime } from ${JSON.stringify(new URL("../../src/server/composition/managed-removal-runtime.ts", import.meta.url).href)};
    const [directory, request, cut] = process.argv.slice(1);
    const kill = () => process.kill(process.pid, "SIGKILL");
    const journals = async (...args) => {
      const journal = await openJournal(...args);
      return { ...journal, write: async (state) => {
        if (state.removalTombstone !== undefined && cut === "before") kill();
        await journal.write(state);
        if (state.removalTombstone !== undefined && cut === "after") kill();
      } };
    };
    const index = await openLifecycleAppIndex(directory, undefined, journals);
    const artifacts = await openArtifactStore(join(dirname(directory), "artifacts"));
    const now = () => 1000;
    const inventory = await index.inspectManagedRemoval("shop", request, { ...artifacts, now });
    const unreachable = () => Promise.reject(new Error("finalization cannot dispatch native effects"));
    const runtime = managedRemovalRuntime(inventory, { ...artifacts, now, authorize: async () => true, native: {
      services: { observe: unreachable, tombstone: unreachable },
      jobs: { observe: unreachable, fence: unreachable },
      containers: { observe: unreachable },
    } });
    await index.completeManagedRemoval("shop", request, { ...runtime, observeWithdrawal: async (intent) => ({
      version: 1, status: "withdrawn", request, action: intent.action, registration: intent.registration, observedAt: now(),
    }) });
    throw new Error("removal did not reach the requested process cut");
  `;
  for (const cut of ["before", "after"] as const) {
    await lab.index().close();
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, lab.directory, request, cut], { stdio: ["ignore", "ignore", "inherit"] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    assert.deepEqual(await once(child, "exit"), [null, "SIGKILL"]);
    await lab.reopen();
    const published = await lab.index().publishedDeploymentStatus("shop");
    assert.ok(published?.version === 1);
    assert.equal(published.retirement?.deadline, intent.createdAt + 90_000);
    assert.equal(published.lifecycle, cut === "before" ? "removal-requested" : "removed");
    assert.equal(await lab.index().resourceSnapshot(), null);
  }
  const tombstone = await lab.index().completeManagedRemoval("shop", request, {
    ...ports, observeWithdrawal: unreachable,
  });
  assert.equal(tombstone.checkpoint, null);
  const purge = randomUUID();
  const operator = { actor: { kind: "operator-control" as const, identity: "fixture-operator" }, reason: "Purge the explicitly removed registration" };
  const purgePorts = {
    now: lab.runtime.now, authorize, native: {
      observe: () => Promise.resolve({ status: "absent" as const }),
      attachments: () => Promise.resolve({ status: "observed" as const, containers: Object.freeze([]), services: Object.freeze([]) }),
      remove: unreachable,
    },
    observeWithdrawal: () => Promise.resolve({
      version: 1, status: "withdrawn", request, action: intent.action, registration: intent.registration, observedAt: lab.runtime.now(),
    }),
  };
  await assert.rejects(lab.index().requestManagedPurge("shop", randomUUID(), purge, operator, purgePorts), /owned removal tombstone/);
  await assert.rejects(lab.index().requestManagedPurge("shop", request, purge, operator, {
    ...purgePorts, native: { ...purgePorts.native, attachments: () => Promise.resolve({
      status: "observed", containers: Object.freeze(["a".repeat(64)]), services: Object.freeze([]),
    }) },
  }), /current attachments/);
  assert.equal(await lab.index().managedPurgeIntent("shop", request, purgePorts), undefined);
  const accepted = await lab.index().requestManagedPurge("shop", request, purge, operator, purgePorts);
  assert.equal(accepted.phase, "preflight");
  assert.equal(accepted.entries[0]?.birth, null);
  await lab.reopen();
  const tick = () => lab.index().tickManagedPurge("shop", request, purge, purgePorts);
  assert.equal((await tick()).phase, "deleting");
  assert.equal((await tick()).entries[0]?.phase, "absent");
  const done = await tick();
  assert.equal(done.phase, "complete");
  assert.equal(done.deadline, accepted.deadline);
  await lab.reopen();
  assert.deepEqual(await tick(), done);
  const projection = await lab.index().publishedDeploymentStatus("shop");
  assert.equal(projection?.version, 1);
  assert.equal(projection.lifecycle, "purged");
  assert.equal(projection.retirement?.remainingVolumes, 0);
  assert.deepEqual((await lab.index().managedRemovalTombstone("shop"))?.volumes, lab.volumes);
  assert.equal(await lab.index().resourceSnapshot(), null);
});
