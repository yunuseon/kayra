import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseRollout, parseRuntime, validateAdmission, type Capability, type Rollout } from "../../src/contracts/rollout.ts";

const baseline = {
  strategy: "rolling",
  mixed_version_compatible: true,
  rollback_compatible: true,
  services: {
    web: { role: "http", overlap: "allowed" },
    worker: { role: "worker", overlap: "forbidden" },
    leader: { role: "singleton", overlap: "coordinated", handoff_check: "handoff" },
    db: { role: "retained-dependency", overlap: "forbidden" },
  },
  migrations: [{ id: "schema", service: "web", command: ["./migrate"], timeout_seconds: 60, recovery: { kind: "status-probe", command: ["./status"], timeout_seconds: 10 } }],
  checks: [{ id: "handoff", service: "leader", command: ["./handoff"], timeout_seconds: 30 }],
};
const capabilities: readonly Capability[] = ["rolling-http", "workers", "singleton", "retained-dependency", "migrations", "checks", "maintenance"];
const parsed = parseRollout(baseline);
if (!parsed.ok) throw new Error(parsed.error);
const rollout: Rollout = parsed.value;
const admission = { runtime: "swarm" as const, swarmEnabled: true, maintenanceGranted: true, rollout, capabilities, composeServices: ["web", "worker", "leader", "db"], routedServices: ["web"], migrationTimeoutCeilingSeconds: 90 };

test("runtime defaults to Compose, without accepting arbitrary values", () => {
  assert.deepEqual(parseRuntime(undefined), { ok: true, value: "compose" });
  assert.deepEqual(parseRuntime("swarm"), { ok: true, value: "swarm" });
  assert.equal(parseRuntime("docker").ok, false);
});

test("metadata is strict, explicit, and does not accept contradictory declarations", () => {
  assert.equal(parseRollout({ ...baseline, surprise: true }).ok, false);
  assert.equal(parseRollout({ ...baseline, mixed_version_compatible: false }).ok, false);
  assert.equal(parseRollout({ ...baseline, rollback_compatible: false }).ok, false);
  assert.equal(parseRollout({ ...baseline, services: { ...baseline.services, web: { role: "http", overlap: "forbidden" } } }).ok, false);
  assert.equal(parseRollout({ ...baseline, services: { ...baseline.services, leader: { role: "singleton", overlap: "allowed" } } }).ok, false);
  assert.equal(parseRollout({ ...baseline, checks: [] }).ok, false);
  assert.equal(parseRollout({ ...baseline, migrations: [{ ...baseline.migrations[0], timeout_seconds: 0 }] }).ok, false);
  assert.equal(parseRollout({ ...baseline, migrations: [{ ...baseline.migrations[0], recovery: { kind: "unknown" } }] }).ok, false);
  assert.equal(parseRollout({ ...baseline, migrations: [baseline.migrations[0], baseline.migrations[0]] }).ok, false);
  assert.equal(parseRollout({ ...baseline, migrations: [{ ...baseline.migrations[0], service: "db" }] }).ok, false);
  assert.equal(parseRollout({ strategy: "maintenance", mixed_version_compatible: false, rollback_compatible: false, services: { db: { role: "retained-dependency", overlap: "forbidden" } } }).ok, true);
});

test("non-singleton coordination is declared in the contract but refused by first-integration admission", () => {
  for (const role of ["http", "worker"]) {
    const declared = parseRollout({ ...baseline, strategy: "maintenance", services: { ...baseline.services, web: { role, overlap: "coordinated" } } });
    assert.equal(declared.ok, true);
    const options = { ...admission, rollout: declared.value, routedServices: role === "http" ? ["web"] : [] };
    const admitted = validateAdmission(options);
    assert.equal(admitted.ok, false);
    assert.match(admitted.error, /coordinated-non-singleton/);
    assert.equal(validateAdmission({ ...options, capabilities: [...capabilities, "coordinated-non-singleton"] }).ok, true);
  }
});

test("admission refuses missing grants, capabilities, backend conversion, and invalid service contracts", () => {
  assert.equal(validateAdmission(admission).ok, true);
  assert.equal(validateAdmission({ ...admission, swarmEnabled: false }).ok, false);
  assert.equal(validateAdmission({ ...admission, rollout: undefined }).ok, false);
  assert.equal(validateAdmission({ ...admission, existingRuntime: "compose" }).ok, false);
  assert.equal(validateAdmission({ ...admission, capabilities: ["rolling-http"] }).ok, false);
  assert.equal(validateAdmission({ ...admission, composeServices: ["web"] }).ok, false);
  assert.equal(validateAdmission({ ...admission, routedServices: ["worker"] }).ok, false);
  assert.equal(validateAdmission({ ...admission, migrationTimeoutCeilingSeconds: 59 }).ok, false);
  assert.equal(validateAdmission({ ...admission, runtime: "compose", rollout: undefined }).ok, true);
  assert.equal(validateAdmission({ ...admission, runtime: "compose" }).ok, false);
  assert.equal(validateAdmission({ ...admission, rollout: { ...rollout, strategy: "maintenance" }, maintenanceGranted: false }).ok, false);
});

test("validated rollout metadata is an immutable snapshot", () => {
  const value = parseRollout(baseline);
  if (!value.ok) throw new Error(value.error);
  const web = value.value.services["web"];
  const migration = value.value.migrations[0];
  const check = value.value.checks[0];
  if (web === undefined || migration === undefined || check === undefined) throw new Error("invalid test fixture");
  assert.equal(Reflect.set(value.value, "rollback_compatible", false), false);
  assert.equal(Reflect.set(web, "role", "worker"), false);
  assert.equal(Reflect.set(migration, "timeout_seconds", 1), false);
  assert.equal(Reflect.set(migration.recovery, "kind", "replay-safe"), false);
  assert.equal(Reflect.set(migration.command, "0", "different"), false);
  assert.equal(Reflect.set(check.command, "0", "different"), false);
  assert.equal(value.value.rollback_compatible, true);
  assert.equal(web.role, "http");
});
