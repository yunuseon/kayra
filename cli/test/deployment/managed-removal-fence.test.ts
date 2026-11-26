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
