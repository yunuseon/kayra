/* eslint-disable functional/no-let, functional/immutable-data -- models synchronized journals, interruption and the one shared resource book */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { typed } from "../../src/lib/typed.ts";
import type { JournalValue } from "../../src/server/deployment/journal.ts";
import type { ManagedAdmissionPort } from "../../src/contracts/managed-admission.ts";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { managedLifecycleOwner } from "../../src/server/deployment/managed-lifecycle-owner.ts";
import { openLifecycleEnvelopeStore } from "../../src/server/deployment/lifecycle-envelope-store.ts";
import { parseLifecycleEnvelope } from "../../src/server/deployment/lifecycle-envelope.ts";
import { beginLifecycleRegistration } from "../../src/server/deployment/lifecycle-fence.ts";
import { fenceUnstartedManagedAdmission, observeManagedAdmission, reserveManagedAdmission, settleManagedAdmission } from "../../src/server/deployment/managed-admission-binding.ts";
import type { ManagedAdmissionAccounting } from "../../src/server/deployment/managed-admission-binding.ts";

const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const fixture = async () => {
  const { plan } = await managedPlanFixture(); const registration = plan.infrastructure.registration;
  const source = parseManagedLifecycleSource({ version: 1, candidate: plan, previous: null, retained: [], retired: [], run: randomUUID(), action: registration.incarnation + ":2", createdAt: 1000 });
  let clock = 1000; let acceptedAuthority = true; let workloadAuthority = true;
  let envelope: JournalValue | undefined; let root: JournalValue | undefined; let cut: "before" | "after" | null = null;
  const view = () => ({ read: () => Promise.resolve(structuredClone(envelope)), write: (value: JournalValue) => {
    if (cut === "before") return Promise.reject(new Error("before envelope replacement")); envelope = structuredClone(value);
    return cut === "after" ? Promise.reject(new Error("lost envelope acknowledgement")) : Promise.resolve();
  } });
  const open = () => openLifecycleEnvelopeStore(view(), (expected) => Promise.resolve({ ...expected, status: "applied" })); let store = open();
  await store.initialize(registration.app, registration.incarnation); const ticket = await store.reserveRegistration(registration.registrationGeneration, "swarm"); await store.submitRegistration(ticket, registration.registrationGeneration); await store.reconcileRegistration(ticket, registration.registrationGeneration);
  let accounting: ManagedAdmissionAccounting = { resources: null, bindings: [] }; const artifacts = new Map<string, string>();
  const host = plan.host; const observation = { status: "ready", engine: "fixture", api: "1.57", node: host.node, cluster: host.cluster, network: host.network.id, capacity: { cpu: host.profile.cpu_millicores, memory: host.profile.memory_bytes }, standing: { cpu: host.profile.platform_cpu_millicores, memory: host.profile.platform_memory_bytes } } as const;
  const admission = typed<ManagedAdmissionPort>({
    reserve: (identity, claim) => { const next = reserveManagedAdmission(accounting, observation, identity, claim, clock); if (!next.ok) return Promise.resolve("refused"); accounting = next.value; return Promise.resolve("reserved"); },
    observe: (identity, claim) => { const value = observeManagedAdmission(accounting, identity, claim); return Promise.resolve(value.ok ? value.value : "unavailable"); },
    settle: (identity, claim, result) => { const next = settleManagedAdmission(accounting, identity, claim, result); if (!next.ok) return Promise.resolve("refused"); accounting = next.value; return Promise.resolve("settled"); },
    settleUnstarted: (identity, claim) => { const next = fenceUnstartedManagedAdmission(accounting, identity, claim); if (!next.ok) return Promise.resolve("refused"); accounting = next.value; return Promise.resolve("settled"); },
  });
  const unreachable = () => Promise.reject(new Error("unstarted run must not invoke native effects"));
  const owner = managedLifecycleOwner({ read: () => Promise.resolve(structuredClone(root)), write: (value) => { root = structuredClone(value); return Promise.resolve(); } }, plan.infrastructure.ownership, {
    now: () => clock, admission, authorize: (_source, effect) => Promise.resolve(effect.kind === "accepted-recovery" ? acceptedAuthority : workloadAuthority),
    retain: (bytes) => { const digest = createHash("sha256").update(bytes).digest("hex"); artifacts.set(digest, bytes); return Promise.resolve(digest); },
    read: (digest) => { const bytes = artifacts.get(digest); if (bytes === undefined) throw new Error("missing artifact"); return Promise.resolve(bytes); },
    services: { observe: unreachable, observeDesired: unreachable, apply: unreachable, tombstone: unreachable },
    jobs: { observe: unreachable, create: unreachable, start: unreachable, fence: unreachable }, readiness: { check: unreachable },
  });
  return { source, owner, clock: (at: number) => { clock = at; }, denyAccepted: () => { acceptedAuthority = false; }, denyWorkloads: () => { workloadAuthority = false; }, store: () => store, saved: () => structuredClone(envelope), accounting: () => accounting, cut: (where: "before" | "after") => { cut = where; }, reopen: () => { cut = null; store = open(); } };
};

test("managed requests atomically own the existing deployment ticket and registration gate", async () => {
  const lab = await fixture(); const request = await lab.store().prepareManaged(lab.source, 1000); assert.equal(request.action, lab.source.action); assert.equal(request.completion, null);
  const saved = await lab.store().read(); assert.ok(saved); assert.equal(saved.operations[0]?.ticket, request.ticket); assert.equal(beginLifecycleRegistration(saved.fence).ok, false);
  assert.deepEqual(await lab.store().prepareManaged(lab.source, 999999), request);
  await assert.rejects(lab.store().prepareManaged({ ...lab.source, run: randomUUID(), action: lab.source.candidate.infrastructure.ownership.incarnation + ":3" }, 1000), /busy/);
  await assert.rejects(lab.store().prepareManaged({ ...lab.source, candidate: { ...lab.source.candidate, commit: "b".repeat(40) } }, 1000), /conflicts/);
  assert.equal((await lab.store().read())?.managed?.length, 1);
});

for (const cut of ["before", "after"] as const) test(`shared managed admission survives interruption ${cut} envelope replacement`, async () => {
  const lab = await fixture(); lab.cut(cut); await assert.rejects(lab.store().prepareManaged(lab.source, 1000)); await assert.rejects(lab.store().read(), /uncertain/); lab.reopen();
  const request = await lab.store().prepareManaged(lab.source, 1000); assert.equal((await lab.store().read())?.managed?.length, 1); assert.equal(request.action, lab.source.action);
});

test("only the matching settled root releases the shared gate, and a lost completion ACK is reconstructed", async () => {
  const lab = await fixture(); await lab.store().prepareManaged(lab.source, 1000); await lab.owner.begin(lab.source); await lab.owner.cancel(); const held = await lab.owner.read(); assert.ok(held);
  await assert.rejects(lab.store().completeManaged(held, hash(held)), /terminal root/);
  await lab.owner.tick(); const done = await lab.owner.tick(); assert.equal(done?.operation.phase, "complete"); assert.ok(done); assert.equal(lab.accounting().resources?.charges[0]?.result, "absent");
  const foreign = { ...done, owner: { ...done.owner, dataOwner: randomUUID() } }; await assert.rejects(lab.store().completeManaged(foreign, hash(foreign)), /terminal root/);
  await assert.rejects(lab.store().completeManaged(done, "e".repeat(64)), /terminal root/);
  lab.cut("after"); await assert.rejects(lab.store().completeManaged(done, hash(done)), /lost envelope/); lab.reopen();
  const receipt = await lab.store().completeManaged(done, hash(done)); assert.equal(receipt.completion?.disposition, "cancelled"); assert.equal(receipt.completion.outcome, "absent");
  const idle = await lab.store().read(); assert.ok(idle); assert.equal(idle.operations.length, 0); assert.equal(beginLifecycleRegistration(idle.fence).ok, true);
});

test("expired new requests and inconsistent managed references fail before issuing tickets", async () => {
  const lab = await fixture(); const before = lab.saved(); await assert.rejects(lab.store().prepareManaged(lab.source, 91000), /expired/); assert.deepEqual(lab.saved(), before);
  await lab.store().prepareManaged(lab.source, 1000); const saved = await lab.store().read(); assert.ok(saved?.managed?.[0]); const request = saved.managed[0];
  for (const changed of [{ ...request, ticket: "unknown" }, { ...request, plan: "e".repeat(64) }, { ...request, action: request.owner.incarnation + ":3" }, { ...request, owner: { ...request.owner, incarnation: randomUUID() } }]) assert.equal(parseLifecycleEnvelope({ ...saved, managed: [changed] }).ok, false);
});

test("restart after accepted intent but before root creation closes expiry without fresh workload authority", async () => {
  const lab = await fixture(); const request = await lab.store().prepareManaged(lab.source, 1000); lab.reopen(); lab.clock(request.deadline + 1000);
  await assert.rejects(lab.owner.begin(lab.source), /not authorized/); assert.equal(await lab.owner.read(), undefined);
  const held = await lab.owner.adoptAccepted(lab.source, request); assert.equal(held.operation.phase, "held"); assert.equal(held.operation.reason, "deadline"); assert.equal(held.operation.admissionDeadline, request.admissionDeadline); assert.equal(held.operation.deadline, request.deadline);
  await lab.owner.tick(); const done = await lab.owner.tick(); assert.equal(done?.operation.phase, "complete"); assert.ok(done); assert.equal(done.operation.outcome, "absent"); assert.equal(done.operation.admitted, false);
  assert.equal((await lab.store().completeManaged(done, hash(done))).completion?.disposition, "failure");
});

test("receipt adoption needs independent current metadata authority and cannot change the immutable source", async () => {
  const lab = await fixture(); const request = await lab.store().prepareManaged(lab.source, 1000);
  await assert.rejects(lab.owner.adoptAccepted(lab.source, { ...request, source: "e".repeat(64) }), /source disagrees/);
  lab.denyAccepted(); await assert.rejects(lab.owner.adoptAccepted(lab.source, request), /receipt is not authorized/); assert.equal(await lab.owner.read(), undefined);
});

test("revoked grants after shared acceptance settle an unstarted run without authorizing workloads", async () => {
  const lab = await fixture(); const request = await lab.store().prepareManaged(lab.source, 1000); lab.denyWorkloads(); await assert.rejects(lab.owner.begin(lab.source), /not authorized/);
  const held = await lab.owner.adoptAccepted(lab.source, request); assert.equal(held.operation.reason, "authorization"); assert.equal(held.operation.admissionDeadline, request.admissionDeadline);
  await lab.owner.tick(); const done = await lab.owner.tick(); assert.ok(done); assert.equal(done.operation.phase, "complete"); assert.equal(done.operation.admitted, false); assert.equal((await lab.store().completeManaged(done, hash(done))).completion?.disposition, "failure");
});

test("adopting the accepted reference cannot reset an existing root or rewrite its failure", async () => {
  const lab = await fixture(); const request = await lab.store().prepareManaged(lab.source, 1000); const first = await lab.owner.begin(lab.source);
  assert.deepEqual(await lab.owner.adoptAccepted(lab.source, request), first); await lab.owner.cancel(); const cancelled = await lab.owner.read();
  assert.deepEqual(await lab.owner.adoptAccepted(lab.source, request), cancelled);
});
