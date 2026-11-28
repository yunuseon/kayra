import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { managedAdmissionDescription } from "../../src/server/deployment/managed-transition.ts";
import { parseManagedAdmissionIdentity } from "../../src/contracts/managed-admission.ts";
import { fenceUnstartedManagedAdmission, observeManagedAdmission, parseManagedAdmissionAccounting, reserveManagedAdmission, settleManagedAdmission, transferManagedAdmission } from "../../src/server/deployment/managed-admission-binding.ts";
import { reserveResources } from "../../src/server/deployment/resource-book.ts";

const fixture = async () => {
  const { plan } = await managedPlanFixture(); const claim = managedAdmissionDescription(plan, null); assert.ok(claim.ok);
  const identity = parseManagedAdmissionIdentity({ owner: plan.infrastructure.ownership, run: randomUUID(), action: plan.infrastructure.ownership.incarnation + ":2", source: "e".repeat(64), plan: claim.value.planDigest, deadline: 91000 }); assert.ok(identity.ok);
  const observation = { status: "ready", engine: "29.9.3", api: "1.56", node: plan.host.node, cluster: plan.host.cluster, network: plan.host.network.id,
    capacity: { cpu: plan.host.profile.cpu_millicores, memory: plan.host.profile.memory_bytes }, standing: { cpu: plan.host.profile.platform_cpu_millicores, memory: plan.host.profile.platform_memory_bytes } } as const;
  return { plan, claim: claim.value, identity: identity.value, observation, empty: { resources: null, bindings: [] } };
};

test("binding survives reopen and expiry without renewing or repeating admission, then settles idempotently", async () => {
  const { empty, identity, claim, observation } = await fixture();
  const reserved = reserveManagedAdmission(empty, observation, identity, claim, 1000); assert.ok(reserved.ok);
  const restored = parseManagedAdmissionAccounting(JSON.parse(JSON.stringify(reserved.value))); assert.ok(restored.ok);
  assert.deepEqual(observeManagedAdmission(restored.value, identity, claim), { ok: true, value: "reserved" });
  assert.deepEqual(reserveManagedAdmission(restored.value, { status: "unavailable" }, identity, claim, 999999), reserved);
  const settled = settleManagedAdmission(restored.value, identity, claim, "target"); assert.ok(settled.ok);
  assert.deepEqual(observeManagedAdmission(settled.value, identity, claim), { ok: true, value: "settled-target" });
  assert.deepEqual(settleManagedAdmission(settled.value, identity, claim, "target"), settled);
  assert.equal(settleManagedAdmission(settled.value, identity, claim, "absent").ok, false);
  assert.equal(reserveManagedAdmission(settled.value, observation, identity, claim, 1000).ok, false);
});

test("neither legacy sequence collisions nor changed run, source, data owner or deadline can adopt a charge", async () => {
  const { empty, identity, claim, observation } = await fixture(); const reserved = reserveManagedAdmission(empty, observation, identity, claim, 1000); assert.ok(reserved.ok);
  const legacy = { resources: reserved.value.resources, bindings: [] };
  assert.deepEqual(observeManagedAdmission(legacy, identity, claim), { ok: true, value: "foreign" });
  assert.equal(reserveManagedAdmission(legacy, observation, identity, claim, 1000).ok, false);
  for (const changed of [{ ...identity, run: randomUUID() }, { ...identity, source: "f".repeat(64) }, { ...identity, deadline: 92000 }, { ...identity, owner: { ...identity.owner, dataOwner: randomUUID() } }]) {
    assert.notDeepEqual(observeManagedAdmission(reserved.value, changed, claim), { ok: true, value: "reserved" });
    assert.equal(reserveManagedAdmission(reserved.value, observation, changed, claim, 1000).ok, false);
    assert.equal(settleManagedAdmission(reserved.value, changed, claim, "absent").ok, false);
  }
  assert.equal(reserveManagedAdmission(empty, observation, identity, { ...claim, rollbackEligible: true }, 1000).ok, false);
  assert.equal(reserveManagedAdmission(empty, observation, identity, { ...claim, resources: { ...claim.resources, peak: { cpu: 1, memory: 1 } } }, 1000).ok, false);
});

test("legacy pending workloads consume the same host capacity and are preserved by managed decisions", async () => {
  const { plan, empty, identity, claim, observation } = await fixture();
  const cpu = plan.host.profile.cpu_millicores - plan.host.profile.platform_cpu_millicores;
  const budget = { cpu, memory: claim.resources.peak.memory };
  const legacy = reserveResources(null, plan.host, observation, { app: "legacy", incarnation: randomUUID(), sequence: 1, target: { plan: "b".repeat(64), budget }, previous: null, peak: budget, deadline: 91000, result: "pending" }, 1000); assert.ok(legacy.ok);
  assert.equal(reserveManagedAdmission({ ...empty, resources: legacy.value }, observation, identity, claim, 1000).ok, false);
  const small = { ...legacy.value, charges: legacy.value.charges.map((charge) => ({ ...charge, target: { ...charge.target, budget: { cpu: 1, memory: 1 } }, peak: { cpu: 1, memory: 1 } })) };
  const combined = reserveManagedAdmission({ ...empty, resources: small }, observation, identity, claim, 1000); assert.ok(combined.ok);
  assert.deepEqual(combined.value.resources?.charges.find((charge) => charge.app === "legacy"), small.charges[0]);
  assert.equal(combined.value.resources?.charges.length, 2);
});

test("a next run replaces only its settled binding and requires the exact previous active charge", async () => {
  const { empty, identity, claim, observation, plan } = await fixture(); const reserved = reserveManagedAdmission(empty, observation, identity, claim, 1000); assert.ok(reserved.ok);
  const settled = settleManagedAdmission(reserved.value, identity, claim, "target"); assert.ok(settled.ok);
  const next = { ...identity, run: randomUUID(), action: identity.owner.incarnation + ":3", source: "f".repeat(64) };
  assert.deepEqual(observeManagedAdmission(settled.value, next, claim), { ok: true, value: "absent" });
  assert.equal(reserveManagedAdmission(settled.value, observation, next, claim, 1000).ok, false);
  const update = managedAdmissionDescription(plan, plan); assert.ok(update.ok);
  const advancing = reserveManagedAdmission(settled.value, observation, next, update.value, 1000); assert.ok(advancing.ok);
  assert.equal(advancing.value.bindings.length, 1); assert.equal(advancing.value.bindings[0]?.run, next.run);
  assert.deepEqual(observeManagedAdmission(advancing.value, identity, claim), { ok: true, value: "foreign" });
  assert.equal(settleManagedAdmission(advancing.value, identity, claim, "target").ok, false);
});

test("missing or corrupted charge bindings fail closed without reconstructing ownership from the book", async () => {
  const { empty, identity, claim, observation } = await fixture(); const reserved = reserveManagedAdmission(empty, observation, identity, claim, 1000); assert.ok(reserved.ok);
  for (const input of [{ ...reserved.value, resources: null }, { ...reserved.value, bindings: [identity, identity] }, { ...reserved.value, bindings: [{ ...identity, action: identity.owner.incarnation + ":3" }] }, { ...reserved.value, bindings: [{ ...identity, plan: "f".repeat(64) }] }]) {
    assert.equal(parseManagedAdmissionAccounting(input).ok, false); assert.equal(observeManagedAdmission(input, identity, claim).ok, false);
    assert.equal(reserveManagedAdmission(input, observation, identity, claim, 1000).ok, false); assert.equal(settleManagedAdmission(input, identity, claim, "absent").ok, false);
  }
});

for (const reserveFirst of [false, true]) test(`unstarted terminal fence closes either reservation race ordering (${String(reserveFirst)})`, async () => {
  const { empty, identity, claim, observation } = await fixture();
  const before = reserveFirst ? reserveManagedAdmission(empty, observation, identity, claim, 1000) : parseManagedAdmissionAccounting(empty); assert.ok(before.ok);
  const closed = fenceUnstartedManagedAdmission(before.value, identity, claim); assert.ok(closed.ok);
  assert.deepEqual(observeManagedAdmission(closed.value, identity, claim), { ok: true, value: "settled-absent" });
  assert.deepEqual(fenceUnstartedManagedAdmission(closed.value, identity, claim), closed);
  assert.equal(reserveManagedAdmission(closed.value, observation, identity, claim, 1000).ok, false);
  assert.equal(reserveManagedAdmission(closed.value, observation, identity, claim, 999999).ok, false);
  assert.equal(fenceUnstartedManagedAdmission(closed.value, { ...identity, source: "f".repeat(64) }, claim).ok, false);
});

test("unstarted update preserves the exact previous budget and permits only a later run to reserve", async () => {
  const { empty, identity, claim, observation, plan } = await fixture();
  const reserved = reserveManagedAdmission(empty, observation, identity, claim, 1000); assert.ok(reserved.ok);
  const active = settleManagedAdmission(reserved.value, identity, claim, "target"); assert.ok(active.ok);
  const update = managedAdmissionDescription(plan, plan); assert.ok(update.ok);
  const next = { ...identity, run: randomUUID(), action: identity.owner.incarnation + ":3" };
  assert.equal(fenceUnstartedManagedAdmission(active.value, next, claim).ok, false);
  const closed = fenceUnstartedManagedAdmission(active.value, next, update.value); assert.ok(closed.ok);
  const charge = closed.value.resources?.charges.find((value) => value.app === identity.owner.app);
  assert.ok(charge); assert.equal(charge.result, "previous"); assert.deepEqual(charge.previous, active.value.resources?.charges[0]?.target);
  assert.equal(reserveManagedAdmission(closed.value, observation, next, update.value, 1000).ok, false);
  assert.equal(reserveManagedAdmission(closed.value, observation, { ...next, action: identity.owner.incarnation + ":4", run: randomUUID() }, update.value, 1000).ok, true);
});

test("unstarted fencing needs no candidate capacity and cannot adopt legacy or foreign pending actions", async () => {
  const { plan, empty, identity, claim, observation } = await fixture();
  const budget = { cpu: plan.host.profile.cpu_millicores - plan.host.profile.platform_cpu_millicores, memory: claim.resources.peak.memory };
  const legacy = reserveResources(null, plan.host, observation, { app: "legacy", incarnation: randomUUID(), sequence: 1, target: { plan: "b".repeat(64), budget }, previous: null, peak: budget, deadline: 91000, result: "pending" }, 1000); assert.ok(legacy.ok);
  const closed = fenceUnstartedManagedAdmission({ ...empty, resources: legacy.value }, identity, claim); assert.ok(closed.ok);
  assert.deepEqual(closed.value.resources?.charges[0], legacy.value.charges[0]);
  const reserved = reserveManagedAdmission(empty, observation, identity, claim, 1000); assert.ok(reserved.ok);
  assert.equal(fenceUnstartedManagedAdmission({ resources: reserved.value.resources, bindings: [] }, identity, claim).ok, false);
  assert.equal(fenceUnstartedManagedAdmission(reserved.value, { ...identity, run: randomUUID() }, claim).ok, false);
  assert.equal(fenceUnstartedManagedAdmission(reserved.value, { ...identity, action: identity.owner.incarnation + ":3" }, claim).ok, false);
  assert.equal(fenceUnstartedManagedAdmission(closed.value, { ...identity, action: identity.owner.incarnation + ":1" }, claim).ok, false);
});

const forwardFixture = async () => {
  const { plan, identity, observation } = await fixture();
  const maintenance = {
    ...plan,
    grants: { ...plan.grants, maintenance: true },
    rollout: { ...plan.rollout, strategy: "maintenance" as const, rollback_compatible: false },
  };
  const oldClaim = managedAdmissionDescription(maintenance, null); assert.ok(oldClaim.ok);
  const blocked = { identity: { ...identity, plan: oldClaim.value.planDigest }, claim: oldClaim.value };
  const nextClaim = managedAdmissionDescription({ ...maintenance, commit: "f".repeat(40) }, null); assert.ok(nextClaim.ok);
  const successor = { identity: { ...identity, action: identity.owner.incarnation + ":3", run: randomUUID(), source: "f".repeat(64), plan: nextClaim.value.planDigest, deadline: 200000 }, claim: nextClaim.value };
  const old = reserveManagedAdmission(nullAccounting, observation, blocked.identity, blocked.claim, 1000); assert.ok(old.ok);
  return { old: old.value, blocked, successor, observation };
};
const nullAccounting = Object.freeze({ resources: null, bindings: Object.freeze([]) });

test("forward transfer replaces the exact pending charge and binding without settling the blocked run", async () => {
  const { old, blocked, successor, observation } = await forwardFixture();
  const moved = transferManagedAdmission(old, observation, blocked, successor, 110000); assert.ok(moved.ok);
  assert.deepEqual(moved.value.bindings, [successor.identity]);
  assert.equal(moved.value.resources?.charges.length, 1);
  assert.equal(moved.value.resources.charges[0]?.result, "pending");
  assert.deepEqual(observeManagedAdmission(moved.value, blocked.identity, blocked.claim), { ok: true, value: "foreign" });
  assert.equal(settleManagedAdmission(moved.value, blocked.identity, blocked.claim, "absent").ok, false);
  assert.deepEqual(transferManagedAdmission(moved.value, { status: "unavailable" }, blocked, successor, 999999), moved);
});

test("forward transfer rejects wrong bindings, stale windows and absent retained dependencies", async () => {
  const { old, blocked, successor, observation } = await forwardFixture();
  for (const now of [109999, 200000]) assert.equal(transferManagedAdmission(old, observation, blocked, successor, now).ok, false);
  assert.equal(transferManagedAdmission(old, { status: "unavailable" }, blocked, successor, 110000).ok, false);
  assert.equal(transferManagedAdmission(old, observation, { ...blocked, identity: { ...blocked.identity, run: randomUUID() } }, successor, 110000).ok, false);
  const settled = settleManagedAdmission(old, blocked.identity, blocked.claim, "target"); assert.ok(settled.ok);
  assert.equal(transferManagedAdmission(settled.value, observation, blocked, successor, 110000).ok, false);
  const candidate = successor.claim.plan;
  const db = candidate.services["db"]; assert.ok(db);
  const changed = managedAdmissionDescription({ ...candidate, services: { ...candidate.services, db: { ...db, command: ["different-engine"] } } }, null); assert.ok(changed.ok);
  assert.deepEqual(transferManagedAdmission(old, observation, blocked, { identity: { ...successor.identity, plan: changed.value.planDigest }, claim: changed.value }, 110000), { ok: false, error: "managed admission transfer changes retained workload accounting" });
});

test("forward admission counts other apps against the replacement peak and leaves their charges intact", async () => {
  const { old, blocked, successor, observation } = await forwardFixture();
  const book = old.resources; assert.ok(book);
  const existing = book.charges[0]; assert.ok(existing);
  const cpu = observation.capacity.cpu - observation.standing.cpu - existing.peak.cpu;
  const budget = { cpu, memory: 1 };
  const legacy = reserveResources(book, book.host, observation, { app: "legacy", incarnation: randomUUID(), sequence: 1, target: { plan: "b".repeat(64), budget }, previous: null, peak: budget, deadline: 91000, result: "pending" }, 1000); assert.ok(legacy.ok);
  const combined = { ...old, resources: legacy.value };
  const moved = transferManagedAdmission(combined, observation, blocked, successor, 110000); assert.ok(moved.ok);
  assert.deepEqual(moved.value.resources?.charges.find((item) => item.app === "legacy"), legacy.value.charges.find((item) => item.app === "legacy"));

  const plan = successor.claim.plan;
  const worker = plan.services["worker"]; assert.ok(worker);
  const bigger = managedAdmissionDescription({ ...plan, services: { ...plan.services, worker: { ...worker, resources: { ...worker.resources, nanoCpus: worker.resources.nanoCpus + 10000000 } } } }, null); assert.ok(bigger.ok);
  assert.equal(transferManagedAdmission(combined, observation, blocked, { identity: { ...successor.identity, plan: bigger.value.planDigest }, claim: bigger.value }, 110000).ok, false);
  assert.deepEqual(observeManagedAdmission(combined, blocked.identity, blocked.claim), { ok: true, value: "reserved" });
});
