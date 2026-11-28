import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedApplicationPlan, managedApplicationDigest, managedMigrationDescription } from "../../src/contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { managedServiceDigest, managedServiceName } from "../../src/contracts/managed-service-plan.ts";
import { migrationSequenceDigest } from "../../src/contracts/migration-sequence.ts";
import { parseManagedGroupPreparation } from "../../src/server/deployment/managed-group-preparation.ts";
import { describeManagedRecovery } from "../../src/server/deployment/managed-recovery-description.ts";

const checked = (value: unknown) => { const result = parseManagedApplicationPlan(value); assert.ok(result.ok, result.ok ? "" : result.error); return result.value; };
const fixture = async () => {
  const data = await managedPlanFixture(); const plan = checked({ ...data.plan, rollout: { ...data.plan.rollout, migrations: [] } });
  const actionFor = (name: string, context = plan) => { const spec = context.services[name]; assert.ok(spec); return { app: spec.owner.app, incarnation: spec.owner.incarnation, dataOwner: spec.owner.dataOwner, service: name, action: spec.owner.incarnation + ":1", effect: "apply" as const, plan: managedServiceDigest(spec), deadline: 999 }; };
  const db = actionFor("db"); const baseline = { kind: "active" as const, action: db, native: { id: "d".repeat(25), version: 1 } };
  const preparation = (target: ManagedApplicationPlan, existing = true) => parseManagedGroupPreparation({ version: 1, app: db.app, incarnation: db.incarnation, dataOwner: db.dataOwner, run: randomUUID(), action: db.incarnation + ":2", plan: managedApplicationDigest(target), createdAt: 1000, startupDeadline: 91000, migrationDeadline: 181000, consumerDeadline: null, sequencePlan: null, sequence: null, phase: "dependencies", reason: null,
    nodes: Object.values(target.services).filter((spec) => spec.role === "retained-dependency").map((spec) => ({ name: spec.service, plan: managedServiceDigest(spec), baseline: existing && spec.service === "db" ? baseline : null, execution: null, ready: null })),
  });
  const baselines = ["web", "worker"].map((name) => ({ name, action: actionFor(name), native: { id: name.padEnd(25, "s"), version: 1 } }));
  return { data, plan, actionFor, baseline, preparation, baselines };
};

test("group recovery includes every consumer and new retained workload before releasing candidate resources", async () => {
  const lab = await fixture(); const worker = lab.plan.services["worker"]; const db = lab.plan.services["db"]; assert.ok(worker); assert.ok(db);
  const candidate = checked({ ...lab.plan, services: { ...lab.plan.services, extra: { ...worker, service: "extra", nativeName: managedServiceName(worker.owner, "extra") }, cache: { ...db, service: "cache", nativeName: managedServiceName(db.owner, "cache") } },
    rollout: { ...lab.plan.rollout, services: { ...lab.plan.rollout.services, extra: { role: "worker", overlap: "forbidden" }, cache: { role: "retained-dependency", overlap: "forbidden" } } } });
  const result = describeManagedRecovery(candidate, lab.plan, lab.preparation(candidate), null, lab.baselines);
  assert.deepEqual(result.nodes.map((node) => node.name), ["cache", "extra", "web", "worker"]); assert.deepEqual(result.retained.map((node) => node.name), ["db"]);
  assert.equal(result.nodes.find((node) => node.name === "cache")?.baseline, null); assert.ok(result.nodes.find((node) => node.name === "web")?.baseline);
});

test("a removed previous consumer is still restored from its exact baseline", async () => {
  const lab = await fixture(); const candidate = checked({ ...lab.plan, services: Object.fromEntries(Object.entries(lab.plan.services).filter(([name]) => name !== "worker")), rollout: { ...lab.plan.rollout, services: Object.fromEntries(Object.entries(lab.plan.rollout.services).filter(([name]) => name !== "worker")) } });
  const result = describeManagedRecovery(candidate, lab.plan, lab.preparation(candidate), null, lab.baselines);
  const worker = result.nodes.find((node) => node.name === "worker"); assert.ok(worker); assert.deepEqual(worker.baseline, lab.baselines.find((node) => node.name === "worker")?.native);
});

test("failed first deployment cleanup covers retained services without inventing a verified active release", async () => {
  const lab = await fixture(); const result = describeManagedRecovery(lab.plan, null, lab.preparation(lab.plan, false), null, []);
  assert.equal(result.previous, null); assert.deepEqual(result.retained, []); assert.deepEqual(result.nodes.map((node) => node.name), ["db", "web", "worker"]); assert.ok(result.nodes.every((node) => node.baseline === null));
});

test("missing baselines, revoked rollback grants and changed retained specifications refuse before effects", async () => {
  const lab = await fixture(); assert.throws(() => describeManagedRecovery(lab.plan, lab.plan, lab.preparation(lab.plan), null, lab.baselines.slice(1)), /references/);
  const web = lab.plan.services["web"]; const db = lab.plan.services["db"]; assert.ok(web); assert.ok(db);
  const revoked = checked({ ...lab.plan, secrets: [], services: { ...lab.plan.services, web: { ...web, inputs: { ...web.inputs, environment: {} } } } });
  assert.throws(() => describeManagedRecovery(revoked, lab.plan, lab.preparation(revoked), null, lab.baselines), /authority/);
  const changed = checked({ ...lab.plan, services: { ...lab.plan.services, db: { ...db, command: ["changed-database-engine"] } } });
  assert.throws(() => describeManagedRecovery(changed, lab.plan, lab.preparation(changed, false), null, lab.baselines), /retained/);
});

test("migration identities bind to the immutable candidate rather than an arbitrary journal digest", async () => {
  const lab = await fixture(); const prefix = { ...lab.preparation(lab.plan), sequencePlan: "a".repeat(64) };
  assert.throws(() => describeManagedRecovery(lab.plan, null, prefix, null, []), /migration description/);
});

test("an unresolved unfenced migration blocks compensation even when the app declares rollback compatibility", async () => {
  const lab = await fixture(); const plan = lab.data.plan; const base = lab.preparation(plan); const description = managedMigrationDescription(plan, base.run); assert.ok(description.ok);
  const sequencePlan = migrationSequenceDigest(description.value); const artifact = "a".repeat(64);
  const sequence = { version: 1, plan: sequencePlan, scope: { app: base.app, incarnation: base.incarnation, run: base.run }, createdAt: 1000, deadline: base.migrationDeadline, completedAt: null, phase: "held", position: 0, reason: "unsafe-outcome",
    steps: [{ id: "schema", phase: "held", reason: "unsafe-outcome", appliedAt: null, executionDeadline: null, attempts: [{ purpose: "migration", attempt: 1, createdAt: 1000, artifact, execution: { version: 1, plan: artifact, scope: { app: base.app, incarnation: base.incarnation, run: base.run, step: "schema", purpose: "migration", attempt: 1 }, createdAt: 1000, deadline: base.migrationDeadline, phase: "create-intent", container: null, evidence: null, fenceDeadline: null, barrier: null, fenceTargets: [], executionDeadline: null, expiry: null } }] }] };
  const prefix = parseManagedGroupPreparation({ ...base, phase: "held", reason: "migration", sequencePlan, sequence, nodes: base.nodes.map((node) => ({ ...node, ready: { action: lab.baseline.action, native: lab.baseline.native, at: 1000 } })) });
  assert.throws(() => describeManagedRecovery(plan, lab.plan, prefix, null, lab.baselines), /resolved and fenced/);
});
