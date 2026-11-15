import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedApplicationDigest, parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { managedServiceDigest, managedServiceName } from "../../src/contracts/managed-service-plan.ts";
import { compileManagedApplicationPlan, managedImageDeclarations } from "../../src/server/deployment/managed-application-plan.ts";

const fixture = managedPlanFixture;

test("managed compilation joins operator infrastructure, native image identities, bindings and allocation metadata without effects", async () => {
  const { plan, scope } = await fixture(); assert.equal(plan.version, 3); assert.deepEqual(Object.keys(plan.services), ["db", "web", "worker"]);
  const db = plan.services["db"]; const web = plan.services["web"]; const databaseImage = scope.images[1]; assert.ok(db && web && databaseImage);
  assert.equal(db.image, databaseImage.pull); assert.equal(db.host.routingNetwork, null); assert.equal(web.host.routingNetwork, scope.authority.network.id);
  assert.deepEqual(web.inputs.environment["TOKEN"], { kind: "secret", key: "TOKEN" }); assert.deepEqual(web.inputs.environment["LITERAL"], { kind: "literal", value: "$welcome" });
  assert.equal(JSON.stringify(plan).includes("createdAt"), false); assert.ok(Object.isFrozen(plan.services)); assert.ok(Object.isFrozen(db.mounts));
  assert.match(managedApplicationDigest(plan), /^[a-f0-9]{64}$/);
});

test("managed compilation refuses unsupported capability, wrong registration and missing image or volume authority", async () => {
  const { scope, artifact, description } = await fixture();
  for (const candidate of [
    { ...scope, capabilities: ["rolling-http"] as const }, { ...scope, volumes: [] }, { ...scope, images: [] },
    { ...scope, infrastructure: { ...scope.infrastructure, registration: { ...scope.registration, registrationGeneration: randomUUID() } } },
    { ...scope, configuration: { ...scope.configuration, keys: ["TOKEN"] } },
  ]) assert.equal(compileManagedApplicationPlan(candidate, artifact, description).ok, false);
  assert.equal(compileManagedApplicationPlan(scope, { ...artifact, registration: { ...scope.registration, registrationGeneration: randomUUID() } }, description).ok, false);
  const extended = { ...description, ignored: true }; assert.equal(compileManagedApplicationPlan(scope, artifact, extended).ok, false);
});

test("canonical application digests ignore mapping order while retaining ordered migration semantics", async () => {
  const { scope, artifact, description, plan } = await fixture();
  const reordered = compileManagedApplicationPlan({ ...scope, images: [...scope.images].reverse() }, { ...artifact, rollout: { ...artifact.rollout, services: { db: artifact.rollout.services.db, worker: artifact.rollout.services.worker, web: artifact.rollout.services.web } } }, { ...description, services: { worker: description.services.worker, db: description.services.db, web: description.services.web } });
  assert.ok(reordered.ok); assert.equal(managedApplicationDigest(reordered.value), managedApplicationDigest(plan));
  const second = { ...artifact.rollout.migrations[0], id: "data" }; const one = compileManagedApplicationPlan(scope, { ...artifact, rollout: { ...artifact.rollout, migrations: [...artifact.rollout.migrations, second] } }, description);
  const two = compileManagedApplicationPlan(scope, { ...artifact, rollout: { ...artifact.rollout, migrations: [second, ...artifact.rollout.migrations] } }, description);
  assert.ok(one.ok && two.ok); assert.notEqual(managedApplicationDigest(one.value), managedApplicationDigest(two.value));
});

test("changed source indexes retain provenance without changing a retained service's selected image", async () => {
  const { scope, artifact, description, plan } = await fixture(); const changed = "localhost:5000/shop/database@sha256:" + "f".repeat(64);
  const images = scope.images.map((image) => image.source.includes("/database@") ? { ...image, source: changed } : image);
  const candidate = compileManagedApplicationPlan({ ...scope, images }, { ...artifact, artifact: "1".repeat(64), images: artifact.images.map((image) => image.variable === "DATABASE_IMAGE" ? { ...image, ref: changed } : image) }, description);
  assert.ok(candidate.ok); const before = plan.services["db"]; const after = candidate.value.services["db"]; assert.ok(before && after);
  assert.equal(managedServiceDigest(before), managedServiceDigest(after)); assert.notEqual(managedApplicationDigest(plan), managedApplicationDigest(candidate.value));
});

test("persisted application validation rejects cross-scope workloads, conflicting data identities and dependency cycles", async () => {
  const { plan } = await fixture(); const web = plan.services["web"]; const db = plan.services["db"]; assert.ok(web && db);
  for (const candidate of [
    { ...plan, services: { ...plan.services, web: { ...web, owner: { ...web.owner, dataOwner: randomUUID() } } } },
    { ...plan, services: { ...plan.services, web: { ...web, privateNetwork: { ...web.privateNetwork, id: "z".repeat(25) } } } },
    { ...plan, services: { ...plan.services, db: { ...db, dependencies: [{ service: "web", condition: "healthy" }] } } },
    { ...plan, services: { ...plan.services, web: { ...web, dependencies: [{ service: "worker", condition: "healthy" }] }, worker: { ...plan.services["worker"], dependencies: [{ service: "web", condition: "healthy" }] } } },
    { ...plan, images: [...plan.images, plan.images[0]] }, { ...plan, hosts: [] }, { ...plan, routes: [...plan.routes, plan.routes[0]] },
    { ...plan, infrastructure: { ...plan.infrastructure, overlay: { ...plan.infrastructure.overlay, id: plan.host.network.id } } },
  ]) assert.equal(parseManagedApplicationPlan(candidate).ok, false);
});

test("maintenance and coordinated singleton plans require explicit grants and a check in the singleton", async () => {
  const { scope, artifact, description } = await fixture();
  const rollout = { ...artifact.rollout, strategy: "maintenance", mixed_version_compatible: false, rollback_compatible: false,
    services: { ...artifact.rollout.services, worker: { role: "singleton", overlap: "coordinated", handoff_check: "handoff" } },
    checks: [{ id: "handoff", service: "worker", command: ["/handoff-check"], timeout_seconds: 30 }],
  } as const;
  assert.equal(compileManagedApplicationPlan(scope, { ...artifact, rollout }, description).ok, false);
  const app = scope.app; assert.equal(app.runtime, "swarm");
  assert.equal(compileManagedApplicationPlan({ ...scope, app: { ...app, grants: { ...app.grants, maintenance: true } } }, { ...artifact, rollout }, description).ok, true);
});

test("dependency validation is bounded for a dense acyclic service graph", { timeout: 5000 }, async () => {
  const { plan } = await fixture(); const template = plan.services["worker"]; assert.ok(template);
  const names = Array.from({ length: 30 }, (_, index) => "worker" + String(index));
  const services = Object.fromEntries(names.map((name, index) => [name, { ...template, service: name, nativeName: managedServiceName(template.owner, name),
    resources: { memoryBytes: 1048576, reserveMemoryBytes: 524288, nanoCpus: 10000000, reserveNanoCpus: 5000000 },
    dependencies: names.slice(index + 1).map((service) => ({ service, condition: "healthy" })),
  }]));
  const candidate = { ...plan, services, routes: [], rollout: { ...plan.rollout, services: Object.fromEntries(names.map((name) => [name, { role: "worker", overlap: "forbidden" }])), migrations: [], checks: [] } };
  assert.equal(parseManagedApplicationPlan(candidate).ok, true);
});

test("registry inspection contexts preserve mounted services and every one-shot independently", async () => {
  const { artifact, description } = await fixture();
  const usages = managedImageDeclarations(artifact, description); assert.ok(usages.ok);
  assert.equal(usages.value.length, 4);
  assert.ok(usages.value.some((usage) => usage.kind === "service" && usage.volumeTargets.includes("/var/lib/database")));
  assert.ok(usages.value.some((usage) => usage.kind === "one-shot" && usage.image === artifact.images[0]?.ref && usage.volumeTargets.length === 0));
  const missing = { ...description, services: { worker: description.services.worker, db: description.services.db } };
  assert.equal(managedImageDeclarations(artifact, missing).ok, false);
});
