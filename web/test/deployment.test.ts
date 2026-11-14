import { expect, test } from "vitest";
import type { DeploymentHealth, DeploymentStatus } from "../../cli/src/clients/wire/contract.gen.ts";
import { deploymentView } from "../src/deployment.ts";

const a = { plan: "a".repeat(64), commit: "a".repeat(40) };
const b = { plan: "b".repeat(64), commit: "b".repeat(40) };
const status: DeploymentStatus = { version: 1, app: "shop", incarnation: "12345678-1234-4234-8234-123456789abc", runtime: "swarm", lifecycle: "registered", verification: "verified",
  requested: b, desired: a, verifiedActive: { ...a, verifiedAt: 1000 }, lastKnownGood: { ...a, verifiedAt: 1000 }, requiredAction: "none", runtimeObservation: "not-observed", preparation: null,
  operation: { request: "23456789-1234-4234-8234-123456789abc", phase: "failed", reason: "runtime", updateDeadline: 90000, recoveryDeadline: 180000, cancelRequestedAt: null, recovery: "automatic-rollback" } };
const health: DeploymentHealth = { version: 1, app: "shop", incarnation: status.incarnation, runtime: "swarm", scope: "runtime-services", observedAt: 2000, state: "available",
  services: [{ name: "web", state: "available", currentTasks: 1, healthyTasks: 1, ignoredHistoricalTasks: 3 }] };

test("healthy restored A does not turn failed requested B into a successful rollout", () => {
  const view = deploymentView(status, health);
  expect(view.phase).toBe("failed"); expect(view.phaseTone).toBe("bad"); expect(view.requested).toBe(b.commit); expect(view.desired).toBe(a.commit); expect(view.active).toBe(a.commit);
  expect(view.runtime).toBe("available"); expect(view.runtimeTone).toBe("ok"); expect(view.recovery).toBe("Previous release restored by the runtime"); expect(view.cancelRequest).toBeNull(); expect(view.services[0]?.ignoredHistoricalTasks).toBe(3);
});

test("a held migration keeps the previous certificate and requires an operator decision", () => {
  const blocked: DeploymentStatus = { ...status, desired: b, operation: null, requiredAction: "inspect-and-resolve", preparation: {
    request: "23456789-1234-4234-8234-123456789abc", phase: "held", reason: "migration", admissionDeadline: 90000, deadline: 900000, migrationDeadline: 720000, httpDeadline: null,
    completedAt: null, cancelRequestedAt: null, recovery: null, migrationOutcomes: [], resolution: null, step: "schema",
  } };
  const view = deploymentView(blocked, health); expect(view.phase).toBe("held"); expect(view.active).toBe(a.commit); expect(view.requested).toBe(b.commit); expect(view.action).toContain("record a recovery decision"); expect(view.cancelRequest).toBeNull();
});

test("health from a different app incarnation is not attached to an old release certificate", () => {
  const view = deploymentView(status, { ...health, incarnation: "34567890-1234-4234-8234-123456789abc" });
  expect(view.runtime).toContain("Registration changed"); expect(view.runtimeTone).toBe("muted"); expect(view.services).toEqual([]); expect(view.observedAt).toBeNull(); expect(view.active).toBe(a.commit);
});

test("fresh unhealthy runtime observations do not erase the historically certified release", () => {
  const view = deploymentView(status, { ...health, state: "unhealthy", services: [{ name: "web", state: "unhealthy", currentTasks: 1, healthyTasks: 0, ignoredHistoricalTasks: 3 }] });
  expect(view.runtimeTone).toBe("bad"); expect(view.runtime).toBe("unhealthy"); expect(view.active).toBe(a.commit); expect(view.observedAt).toBe(2000);
});

test("legacy Compose history remains uncertified and unsupported health is not green", () => {
  const legacy: DeploymentStatus = { ...status, runtime: "compose", verification: "legacy-unverified", requested: null, desired: null, verifiedActive: null, lastKnownGood: null, operation: null };
  const view = deploymentView(legacy, { ...health, runtime: "compose", state: "unsupported", services: [] });
  expect(view.active).toBeNull(); expect(view.requested).toBeNull(); expect(view.runtime).toBe("unsupported"); expect(view.runtimeTone).toBe("muted"); expect(view.phase).toBe("idle");
});

test("cancellation is offered for pending work and removed once the request is recorded", () => {
  if (status.operation === null) throw new Error("fixture lacks operation");
  const pending: DeploymentStatus = { ...status, operation: { ...status.operation, phase: "applying", reason: null, recovery: null } };
  expect(deploymentView(pending).cancelRequest).toBe(status.operation.request);
  expect(deploymentView({ ...pending, operation: { ...status.operation, phase: "recovering", cancelRequestedAt: 1500 } }).cancelRequest).toBeNull();
});
