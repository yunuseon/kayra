/* eslint-disable functional/no-let, functional/immutable-data -- fixture simulates native state and a lost journal acknowledgement */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import type { VolumeObservation } from "../../src/contracts/owned-volume.ts";
import type { IndexedManagedRuntime } from "../../src/server/deployment/indexed-managed-lifecycle.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { parseLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index-state.ts";
import { parseVolumeCreationCatalog } from "../../src/server/deployment/volume-creation-catalog-state.ts";
import { managedRemovalRuntime } from "../../src/server/composition/managed-removal-runtime.ts";
import { managedIndexRuntimeFixture } from "./managed-index-runtime-fixture.ts";

test("a retired verified app reserves its exact data custody and fences purge across a lost acknowledgement", async (t) => {
  let fail = false;
  let indexDirectory = "";
  const journals: typeof openJournal = async (...args) => {
    const journal = await openJournal(...args);
    return { ...journal, write: async (value) => {
      await journal.write(value);
      if (args[0] === indexDirectory && fail && parseLifecycleAppIndex(value).apps.some((entry) => entry.recreation !== undefined)) {
        fail = false;
        throw new Error("lost recreation acknowledgement");
      }
    } };
  };
  const lab = await managedIndexRuntimeFixture(t, false, journals);
  indexDirectory = lab.directory;
  let volumeState: VolumeObservation = { status: "absent" };
  const runtime: IndexedManagedRuntime = { ...lab.runtime, managedData: {
    native: {
      observe: () => Promise.resolve(volumeState),
      create: (action) => {
        volumeState = { status: "owned", receipt: { volume: action.volume, createdAt: new Date(1000).toISOString() } };
        return Promise.resolve("acknowledged");
      },
    },
    workloads: () => lab.runtime.services,
  } };
  const plan = parseManagedApplicationPlan({ ...lab.plan, rollout: { ...lab.plan.rollout, migrations: [] } });
  assert.ok(plan.ok);
  const source = await lab.index().proposeManagedDeployment("shop", plan.value, lab.source.run, {
    ...runtime, compare: () => Promise.resolve("unchanged"),
  });
  await lab.index().requestManagedDeployment("shop", source, runtime);
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await lab.index().tickManagedDeployment("shop", source.run, runtime);
    assert.notEqual(state?.operation.phase, "held");
    if (state?.operation.phase === "complete") break;
  }
  const ready = await lab.index().managedState("shop", runtime);
  assert.ok(ready?.active); assert.equal(ready.operation.phase, "complete");
  const births = await lab.index().recordedManagedVolumes("shop", lab.volumes);
  assert.ok(births?.length);

  const authorize = () => Promise.resolve(true);
  const actor = { kind: "operator-control", identity: "fixture-operator" } as const;
  const remove = randomUUID();
  const removal = await lab.index().requestManagedRemoval("shop", remove, {
    actor, reason: "Retire the old workloads but keep the database",
  }, { now: runtime.now, authorize });
  const inventory = await lab.index().inspectManagedRemoval("shop", remove, runtime);
  const unreachable = () => Promise.reject(new Error("recreation must never start a job or delete a volume"));
  const retiring = managedRemovalRuntime(inventory, { ...runtime, authorize, native: {
    services: {
      observe: lab.runtime.services.observe,
      tombstone: (action, expected) => {
        const service = lab.services.get(action.service);
        assert.ok(service?.status === "owned"); assert.equal(expected?.version, service.version);
        lab.services.set(action.service, { ...service, version: service.version + 1, action: action.action,
          effect: action.effect, taskEffect: "remove", plan: action.plan, tombstone: true,
          retainedInputsCleared: action.effect === "scrub", containersStopped: true, containersConverged: true,
          replicas: 0, endpoint: "dnsrr", update: "completed", tasks: [] });
        return Promise.resolve("acknowledged");
      },
    },
    jobs: { observe: unreachable, fence: unreachable },
    containers: { observe: unreachable },
  } });
  await lab.index().prepareManagedRemovalEffects("shop", remove, retiring);
  for (let attempt = 0; attempt < 90; attempt++) {
    const state = await lab.index().tickManagedRemovalEffects("shop", remove, retiring);
    assert.notEqual(state.phase, "held");
    if (state.phase === "complete") break;
  }
  const withdrawn = () => Promise.resolve({ version: 1, status: "withdrawn", request: remove, action: removal.action,
    registration: removal.registration, observedAt: runtime.now() });
  const accounting = await lab.index().retireManagedRemovalAccounting("shop", remove, retiring);
  const tombstone = await lab.index().completeManagedRemoval("shop", remove, { ...retiring, observeWithdrawal: withdrawn });
  const retiredBook = await lab.index().resourceSnapshot();

  const request = { request: randomUUID(), removal: remove, generation: randomUUID(), reason: "Recreate with the verified release and its retained database" };
  const native = {
    observe: () => Promise.resolve(volumeState),
    attachments: () => Promise.resolve({ status: "observed" as const, containers: [], services: [] }),
  };
  const ports = { ...runtime, authorize, observeWithdrawal: withdrawn, native };
  const reserve = () => lab.index().reserveManagedRecreation("shop", request, actor, ports);
  await assert.rejects(lab.index().reserveManagedRecreation("shop", request, actor, { ...ports,
    native: { ...native, attachments: () => Promise.resolve({ status: "observed", containers: ["a".repeat(64)], services: [] }) },
  }), /detached, recorded data/);
  const previous = volumeState;
  volumeState = { status: "absent" };
  await assert.rejects(reserve(), /detached, recorded data/);
  volumeState = previous;

  fail = true;
  await assert.rejects(reserve(), /lost recreation acknowledgement/);
  await lab.reopen(); lab.clock(3_000);
  const receipt = await lab.index().reserveManagedRecreation("shop", request, actor, { ...ports,
    authorize: () => Promise.resolve(false), observeWithdrawal: unreachable,
  });
  assert.equal(receipt.checkpoint, tombstone.checkpoint); assert.equal(receipt.accounting, accounting.after);
  assert.equal(receipt.release, ready.active.record); assert.equal(receipt.createdAt, 1000); assert.equal(receipt.deadline, 91_000);
  assert.deepEqual(receipt.predecessor, removal.owner); assert.notEqual(receipt.targetIncarnation, removal.owner.incarnation);
  assert.deepEqual(JSON.parse(await lab.artifacts.read(receipt.volumes)), births.map((birth) => ({ volume: birth.volume, birth })));
  const retiredStatus = await lab.index().publishedDeploymentStatus("shop");
  assert.equal(retiredStatus?.version, 1);
  assert.equal(retiredStatus.lifecycle, "removed");
  assert.deepEqual(await lab.index().resourceSnapshot(), retiredBook);
  await assert.rejects(lab.index().prepareApp("shop", "managed-v3"), /owns the next registration/);
  await assert.rejects(lab.index().reserveManagedRecreation("shop", { ...request, generation: randomUUID() }, actor, ports), /request conflicts/);
  await assert.rejects(lab.index().requestManagedPurge("shop", remove, randomUUID(), { actor, reason: request.reason }, {
    ...ports, native: { ...native, remove: unreachable },
  }), /recreation owns the retained data/);

  const prepare = () => lab.index().prepareManagedRecreationWorkspace("shop", request.request, ports);
  await assert.rejects(lab.index().prepareManagedRecreationWorkspace("shop", request.request, {
    ...ports, read: () => Promise.resolve("[]"),
  }), /volume evidence changed/);
  fail = true;
  await assert.rejects(prepare(), /lost recreation acknowledgement/);
  await lab.reopen(); lab.clock(100_000);
  const workspace = await lab.index().prepareManagedRecreationWorkspace("shop", request.request, {
    ...ports, authorize: () => Promise.resolve(false),
  });
  assert.deepEqual(workspace, { ...receipt, workspace: "ready" });
  const catalogFile = join(lab.directory, "recreation-" + receipt.targetIncarnation, "managed", "volumes", "state.json");
  const catalog = parseVolumeCreationCatalog(JSON.parse(await readFile(catalogFile, "utf8")));
  assert.deepEqual(catalog.owner, { ...removal.owner, incarnation: receipt.targetIncarnation });
  assert.deepEqual(catalog.allocations.map((item) => item.inherited?.receipt), births);
  assert.deepEqual(await lab.index().recordedManagedVolumes("shop", lab.volumes), births);

  await rename(catalogFile, catalogFile + ".saved");
  try {
    await assert.rejects(prepare(), /journal files are missing/);
    await assert.rejects(readFile(catalogFile), { code: "ENOENT" });
  } finally {
    await rename(catalogFile + ".saved", catalogFile);
  }
  const stagingStatus = await lab.index().publishedDeploymentStatus("shop");
  assert.equal(stagingStatus?.version, 1);
  assert.equal(stagingStatus.lifecycle, "removed");
});
