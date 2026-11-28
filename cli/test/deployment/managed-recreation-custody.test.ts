/* eslint-disable functional/no-let, functional/immutable-data -- fixture simulates native state and a lost journal acknowledgement */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
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
      if (args[0] === indexDirectory && fail &&
        parseLifecycleAppIndex(value).apps.some((entry) => entry.recreation !== undefined || entry.lineage !== undefined)) {
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
  await lab.reopen(); lab.clock(4_000);
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

  const oldEnvelope = join(lab.directory, createHash("sha256").update("shop").digest("hex"), "state.json");
  const oldBytes = await readFile(oldEnvelope, "utf8");
  const handoff = () => lab.index().switchManagedRecreationOwnership("shop", request.request, ports);
  volumeState = { status: "absent" };
  await assert.rejects(handoff(), /handoff requires detached, recorded data/);
  volumeState = previous;
  fail = true;
  await assert.rejects(handoff(), /lost recreation acknowledgement/);
  await lab.reopen(); lab.clock(5_000);
  const installed = await lab.index().switchManagedRecreationOwnership("shop", request.request, {
    ...ports, authorize: () => Promise.resolve(false), observeWithdrawal: unreachable,
  });
  assert.deepEqual(installed.reservation, workspace);
  assert.deepEqual(await reserve(), workspace);
  assert.deepEqual(await prepare(), workspace);
  const archived = z.object({
    entry: z.object({ incarnation: z.uuid() }),
    charge: z.object({ result: z.literal("absent") }),
    builds: z.array(z.object({ registration: z.object({ incarnation: z.uuid() }) })),
  }).parse(JSON.parse(await lab.artifacts.read(installed.archive)));
  assert.equal(archived.entry.incarnation, lab.incarnation);
  assert.equal(archived.charge.result, "absent");
  assert.equal(archived.builds[0]?.registration.incarnation, lab.incarnation);
  assert.equal(await readFile(oldEnvelope, "utf8"), oldBytes);
  assert.equal(await lab.index().prepareApp("shop", "managed-v3"), workspace.targetIncarnation);
  assert.deepEqual(await lab.index().recordedManagedVolumes("shop", lab.volumes), births);
  assert.deepEqual((await lab.index().resourceSnapshot())?.charges, []);
  assert.deepEqual(await lab.index().pendingManagedDeployments(), []);
  await assert.rejects(lab.index().reserveRegistration("shop", request.generation, "swarm"), /owns the successor registration/);
  const registration = () => lab.index().reserveRecreatedRegistration("shop", request.request, request.generation, ports);
  await assert.rejects(lab.index().reserveRecreatedRegistration("shop", request.request, randomUUID(), ports), /scope disagrees/);
  await assert.rejects(lab.index().reserveRecreatedRegistration("shop", request.request, request.generation, {
    ...ports, authorize: () => Promise.resolve(false),
  }), /authorization or deadline expired/);
  const ticket = await registration();
  assert.equal(ticket.incarnation, workspace.targetIncarnation);
  assert.equal(ticket.deadline, workspace.deadline);
  assert.deepEqual(ticket.withdrawal.registration, removal.registration);
  await lab.index().submitRegistration("shop", ticket.ticket, request.generation);
  await lab.index().reconcileRegistration("shop", ticket.ticket, request.generation);
  const verified = await lab.index().verifiedRegistration("shop");
  assert.equal(verified.incarnation, workspace.targetIncarnation);
  await assert.rejects(lab.index().proposeManagedDeployment("shop", plan.value, randomUUID(), {
    ...ports, compare: () => Promise.resolve("unchanged"),
  }), /requires its verified release rebind/);
  await assert.rejects(lab.index().requestManagedDeployment("shop", source, runtime), /requires its verified release rebind/);
  await lab.reopen(); lab.clock(100_000);
  assert.deepEqual(await lab.index().reserveRecreatedRegistration("shop", request.request, request.generation, {
    ...ports, authorize: () => Promise.resolve(false),
  }), ticket);
});
