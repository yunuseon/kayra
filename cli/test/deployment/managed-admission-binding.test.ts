import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { managedAdmissionDescription } from "../../src/server/deployment/managed-transition.ts";
import { parseManagedAdmissionIdentity } from "../../src/contracts/managed-admission.ts";
import { observeManagedAdmission, parseManagedAdmissionAccounting, reserveManagedAdmission, settleManagedAdmission } from "../../src/server/deployment/managed-admission-binding.ts";
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
