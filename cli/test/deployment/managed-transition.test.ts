import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mock, test } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { managedApplicationDigest } from "../../src/contracts/managed-application-plan.ts";
import { prepareManagedTransition, reserveManagedTransition } from "../../src/server/deployment/managed-transition.ts";
import { settleResources } from "../../src/server/deployment/resource-book.ts";

const clock = () => ({ deadline: Date.now() + 5000, now: Date.now });
const unchanged = { compare: () => Promise.resolve("unchanged" as const) };
const ready = (plan: Awaited<ReturnType<typeof managedPlanFixture>>["plan"]) => ({ status: "ready", engine: "29.9.3", api: "1.56", node: plan.host.node, cluster: plan.host.cluster, network: plan.host.network.id,
  capacity: { cpu: plan.host.profile.cpu_millicores, memory: plan.host.profile.memory_bytes }, standing: { cpu: plan.host.profile.platform_cpu_millicores, memory: plan.host.profile.platform_memory_bytes } } as const);

test("transition admission accounts for retained services, migration probes and rollback overlap", async () => {
  const { plan } = await managedPlanFixture();
  const initial = await prepareManagedTransition(null, plan, [], unchanged, clock()); assert.ok(initial.ok);
  assert.deepEqual(initial.value.resources.target, { cpu: 300, memory: 3 * 33554432 });
  assert.deepEqual(initial.value.resources.peak, { cpu: 300, memory: 3 * 33554432 });
  const update = await prepareManagedTransition(plan, plan, [], unchanged, clock()); assert.ok(update.ok);
  assert.deepEqual(update.value.resources.peak, { cpu: 700, memory: 7 * 33554432 });
  assert.ok(update.value.rollbackEligible);
  assert.equal(update.value.changes.find((item) => item.name === "db")?.kind, "retained");
  const first = reserveManagedTransition(null, ready(plan), initial.value, 1, 91000, 1000); assert.ok(first.ok);
  const active = settleResources(first.value, "shop", plan.infrastructure.registration.incarnation, 1, "target"); assert.ok(active.ok);
  const reserved = reserveManagedTransition(active.value, ready(plan), update.value, 2, 91000, 1000); assert.ok(reserved.ok);
  assert.deepEqual(reserveManagedTransition(reserved.value, { status: "unavailable" }, update.value, 2, 91000, 999999), reserved);
  assert.equal(reserveManagedTransition(reserved.value, ready(plan), update.value, 3, 91000, 1000).ok, false);
  assert.equal(reserveManagedTransition(active.value, ready(plan), { ...update.value, resources: initial.value.resources }, 2, 91000, 1000).ok, false);
  assert.equal(reserveManagedTransition(null, { status: "unavailable" }, initial.value, 1, 91000, 1000).ok, false);
});

test("failed initial dependency baselines remain binding before any active release exists", async () => {
  const { plan } = await managedPlanFixture(); const db = plan.services["db"]; assert.ok(db);
  const changed = { ...plan, services: { ...plan.services, db: { ...db, resources: { ...db.resources, memoryBytes: db.resources.memoryBytes + 1 } } } };
  assert.equal((await prepareManagedTransition(null, changed, [db], unchanged, clock())).ok, false);
  assert.equal((await prepareManagedTransition(null, plan, [db, { ...db, image: db.image.replace(/b/g, "f") }], unchanged, clock())).ok, false);
  assert.equal((await prepareManagedTransition(null, plan, [db], { compare: () => Promise.resolve("changed" as const) }, clock())).ok, false);
  const generation = randomUUID();
  const next = parseManagedApplicationPlan({ ...plan, infrastructure: { ...plan.infrastructure, registration: { ...plan.infrastructure.registration, registrationGeneration: generation } }, services: Object.fromEntries(Object.entries(plan.services).map(([name, service]) => [name, { ...service, inputs: { ...service.inputs, registration: { ...service.inputs.registration, registrationGeneration: generation } } }])) });
  assert.ok(next.ok);
  const carried = await prepareManagedTransition(null, next.value, [db], unchanged, clock()); assert.ok(carried.ok);
  assert.deepEqual(carried.value.plan.services["db"]?.inputs, db.inputs);
  assert.notEqual(carried.value.planDigest, managedApplicationDigest(next.value));
});

test("preparation is bounded, expires without reads and sanitizes unavailable private evidence", async () => {
  const { plan } = await managedPlanFixture();
  const inputs = { compare: mock.fn(() => Promise.resolve("unchanged" as const)) };
  assert.equal((await prepareManagedTransition(plan, plan, [], inputs, { deadline: 1000, now: () => 1000 })).ok, false); assert.equal(inputs.compare.mock.callCount(), 0);
  const expired = await prepareManagedTransition(plan, plan, [], { compare: () => Promise.withResolvers<"unchanged">().promise }, { deadline: Date.now() + 20, now: Date.now });
  assert.ok(!expired.ok); assert.match(expired.error, /deadline/);
  const failed = await prepareManagedTransition(plan, plan, [], { compare: () => { throw new Error("private-secret-value"); } }, clock());
  assert.ok(!failed.ok); assert.equal(failed.error.includes("private-secret-value"), false);
});

test("transitions reject authority changes, retained removal and insufficient overlap grants", async () => {
  const { plan } = await managedPlanFixture();
  const reduced = { ...plan, grants: { ...plan.grants, cpu_millicores: 600 } };
  assert.equal((await prepareManagedTransition(plan, reduced, [], unchanged, clock())).ok, false);
  const removed = parseManagedApplicationPlan({ ...plan, services: Object.fromEntries(Object.entries(plan.services).filter(([name]) => name !== "db").map(([name, service]) => [name, { ...service, dependencies: [] }])), rollout: { ...plan.rollout, services: { web: plan.rollout.services["web"], worker: plan.rollout.services["worker"] } } });
  assert.ok(removed.ok); assert.equal((await prepareManagedTransition(plan, removed.value, [], unchanged, clock())).ok, false);
  const changed = { ...plan, host: { ...plan.host, profile: { ...plan.host.profile, platform_cpu_millicores: plan.host.profile.platform_cpu_millicores + 1 } } };
  assert.equal((await prepareManagedTransition(plan, changed, [], unchanged, clock())).ok, false);
});

test("rolling rollback respects current secret grants without treating unused old grants as required", async () => {
  const { plan } = await managedPlanFixture(); const web = plan.services["web"]; assert.ok(web);
  const candidate = parseManagedApplicationPlan({ ...plan, secrets: [], services: { ...plan.services, web: { ...web, inputs: { ...web.inputs, environment: Object.fromEntries(Object.entries(web.inputs.environment).filter(([key]) => key !== "TOKEN")) } } } }); assert.ok(candidate.ok);
  const denied = await prepareManagedTransition(plan, candidate.value, [], unchanged, clock()); assert.ok(!denied.ok); assert.match(denied.error, /secret grants/);
  const maintenance = parseManagedApplicationPlan({ ...candidate.value, grants: { ...candidate.value.grants, maintenance: true }, rollout: { ...candidate.value.rollout, strategy: "maintenance", rollback_compatible: false } }); assert.ok(maintenance.ok);
  const forward = await prepareManagedTransition(plan, maintenance.value, [], unchanged, clock()); assert.ok(forward.ok); assert.equal(forward.value.rollbackEligible, false);
  const unused = parseManagedApplicationPlan({ ...plan, secrets: [...plan.secrets, "UNUSED"] }); assert.ok(unused.ok);
  assert.ok((await prepareManagedTransition(unused.value, plan, [], unchanged, clock())).ok);
  assert.equal(parseManagedApplicationPlan({ ...plan, secrets: [] }).ok, false);
});

test("an ordinary transition cannot repurpose an existing consumer as a retained dependency", async () => {
  const { plan } = await managedPlanFixture(); const worker = plan.services["worker"]; assert.ok(worker);
  const candidate = parseManagedApplicationPlan({ ...plan, services: { ...plan.services, worker: { ...worker, role: "retained-dependency" } }, rollout: { ...plan.rollout, services: { ...plan.rollout.services, worker: { role: "retained-dependency", overlap: "forbidden" } } } }); assert.ok(candidate.ok);
  const result = await prepareManagedTransition(plan, candidate.value, [], unchanged, clock()); assert.ok(!result.ok); assert.match(result.error, /repurpose an existing consumer/);
});


test("maintenance admission excludes quiesced consumers from migrations and refuses invented rollback eligibility", async () => {
  const { plan } = await managedPlanFixture(); const checked = parseManagedApplicationPlan({ ...plan, grants: { ...plan.grants, maintenance: true, cpu_millicores: 300 }, rollout: { ...plan.rollout, strategy: "maintenance", mixed_version_compatible: false, rollback_compatible: false } }); assert.ok(checked.ok);
  const transition = await prepareManagedTransition(plan, checked.value, [], unchanged, clock()); assert.ok(transition.ok); assert.equal(transition.value.rollbackEligible, false);
  assert.deepEqual(transition.value.resources.frames.startup, { cpu: 300, memory: 3 * 33554432 });
  assert.deepEqual(transition.value.resources.frames.migration, { cpu: 300, memory: 3 * 33554432 });
  assert.deepEqual(transition.value.resources.frames.recovery, transition.value.resources.target);
  assert.deepEqual(transition.value.resources.peak, transition.value.resources.target);
  const initial = await prepareManagedTransition(null, plan, [], unchanged, clock()); assert.ok(initial.ok); const reservation = reserveManagedTransition(null, ready(plan), initial.value, 1, 91000, 1000); assert.ok(reservation.ok); const active = settleResources(reservation.value, "shop", plan.infrastructure.registration.incarnation, 1, "target"); assert.ok(active.ok);
  assert.ok(reserveManagedTransition(active.value, ready(plan), transition.value, 2, 91000, 1000).ok);
  assert.equal(reserveManagedTransition(active.value, ready(plan), { ...transition.value, rollbackEligible: true }, 2, 91000, 1000).ok, false);
  const compatible = parseManagedApplicationPlan({ ...checked.value, rollout: { ...checked.value.rollout, rollback_compatible: true } }); assert.ok(compatible.ok);
  assert.equal((await prepareManagedTransition(plan, compatible.value, [], unchanged, clock())).ok, false);
});
