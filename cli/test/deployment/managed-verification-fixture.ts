import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedApplicationPlan, managedApplicationDigest } from "../../src/contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedServicePlan } from "../../src/contracts/managed-service-plan.ts";
import { managedRecoverySnapshot, managedRecoveryDigest } from "../../src/server/deployment/managed-recovery-description.ts";
import { parseManagedGroupPreparation } from "../../src/server/deployment/managed-group-preparation.ts";
import { parseManagedGroupCompensation } from "../../src/server/deployment/managed-group-compensation.ts";
import { parseManagedConsumerState } from "../../src/server/deployment/managed-consumer-state.ts";

export const managedVerificationFixture = async (checks = false) => {
  const data = await managedPlanFixture(); const parsed = parseManagedApplicationPlan({ ...data.plan, rollout: { ...data.plan.rollout, checks: checks ? [{ id: "confirm", service: "web", command: ["node", "/check.js"], timeout_seconds: 2 }] : [] } }); assert.ok(parsed.ok); const application = parsed.value;
  const action = (service: ManagedServicePlan) => ({ app: service.owner.app, incarnation: service.owner.incarnation, dataOwner: service.owner.dataOwner, service: service.service, action: service.owner.incarnation + ":2", effect: "apply" as const, plan: managedServiceDigest(service), deadline: 91000 });
  const native = (name: string) => Object.freeze({ id: name.padEnd(25, "s"), version: 1 });
  const certificate = parseManagedConsumerState({ version: 1, app: application.infrastructure.ownership.app, incarnation: application.infrastructure.ownership.incarnation, dataOwner: application.infrastructure.ownership.dataOwner, run: randomUUID(), action: application.infrastructure.ownership.incarnation + ":2", plan: managedApplicationDigest(application), previous: null, preparation: "a".repeat(64), createdAt: 1000, deadline: 91000, cursor: 0, phase: "ready", reason: null, verifiedAt: 1000,
    retained: Object.values(application.services).filter((service) => service.role === "retained-dependency").map((service) => Object.freeze({ name: service.service, action: action(service), native: native(service.service) })),
    nodes: Object.values(application.services).filter((service) => service.role !== "retained-dependency").map((service) => Object.freeze({ name: service.service, target: managedServiceDigest(service), baseline: null, quiescence: null,
      execution: { version: 1, mode: "apply", createdAt: 1000, action: action(service), expected: null, phase: "converged", reason: null, verified: { native: native(service.service), at: 1000 } },
      ready: { kind: "running", action: action(service), native: native(service.service), at: 1000, routed: service.role !== "http" ? null : { app: service.owner.app, service: service.service, incarnation: service.owner.incarnation, action: action(service).action, plan: managedServiceDigest(service), checkedAt: 1000, status: "ready" } },
    })),
  });
  return Object.freeze({ kind: "deployment" as const, application, certificate });
};


export const managedRecoveryVerificationFixture = async () => {
  const deployment = await managedVerificationFixture(); const application = deployment.application;
  const checked = parseManagedApplicationPlan({ ...application, rollout: { ...application.rollout, migrations: [] } }); assert.ok(checked.ok); const candidate = checked.value;
  const database = application.services["db"]; assert.ok(database); const before = (service: ManagedServicePlan) => ({ app: service.owner.app, incarnation: service.owner.incarnation, dataOwner: service.owner.dataOwner, service: service.service, action: service.owner.incarnation + ":1", effect: "apply" as const, plan: managedServiceDigest(service), deadline: 999 });
  const prefix = parseManagedGroupPreparation({ version: 1, app: database.owner.app, incarnation: database.owner.incarnation, dataOwner: database.owner.dataOwner, run: deployment.certificate.run, action: database.owner.incarnation + ":2", plan: managedApplicationDigest(candidate), createdAt: 1000, startupDeadline: 91000, migrationDeadline: 181000, consumerDeadline: null, sequencePlan: null, sequence: null, phase: "dependencies", reason: null,
    nodes: [{ name: "db", plan: managedServiceDigest(database), baseline: { kind: "active", action: before(database), native: { id: "db".padEnd(25, "s"), version: 1 } }, execution: null, ready: null }],
  });
  const baselines = Object.values(application.services).filter((service) => service.role !== "retained-dependency").map((service) => Object.freeze({ name: service.service, action: before(service), native: Object.freeze({ id: service.service.padEnd(25, "s"), version: 1 }) }));
  const snapshot = managedRecoverySnapshot({ candidate, previous: application, preparation: prefix, consumers: null, baselines }); const description = snapshot.description;
  const certificate = parseManagedGroupCompensation({ version: 1, app: description.app, incarnation: description.incarnation, dataOwner: description.dataOwner, run: description.run, action: description.action, plan: description.plan, previous: description.previous, description: managedRecoveryDigest(description), source: createHash("sha256").update(JSON.stringify(snapshot.source)).digest("hex"), createdAt: 1000, deadline: 91000, cursor: 0, phase: "verified", reason: null, verifiedAt: 1000,
    nodes: description.nodes.map((node) => {
      const action = { app: description.app, incarnation: description.incarnation, dataOwner: description.dataOwner, service: node.name, action: description.action, plan: node.plan, effect: "restore" as const, deadline: 91000 }; const restore = { ...action, action: action.action + ":restore:1" }; assert.ok(node.baseline); const native = { id: node.baseline.id, version: 2 };
      return { ...node, child: { version: 1, action, createdAt: 1000, candidate: description.plan, previous: description.previous, baseline: node.baseline, prior: node.prior, fences: [], attempts: [{ version: 1, mode: "apply", createdAt: 1000, action: restore, expected: node.baseline, phase: "converged", reason: null, verified: { native, at: 1000 } }], barrier: null, phase: "complete", reason: null, proof: { native, at: 1000 } },
        routed: application.services[node.name]?.role === "http" ? { app: description.app, service: node.name, incarnation: description.incarnation, action: restore.action, plan: node.plan, checkedAt: 1000, status: "ready" } : null };
    }),
  });
  return Object.freeze({ kind: "recovery" as const, application, certificate, recoverySource: snapshot.source });
};
