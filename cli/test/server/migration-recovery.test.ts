import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Migration } from "../../src/contracts/rollout.ts";
import { decideMigrationRecovery, type MigrationRecovery } from "../../src/server/deployment/migration-recovery.ts";

const migration: Migration = { id: "schema", service: "web", command: ["migrate"], timeout_seconds: 30, recovery: { kind: "status-probe", command: ["status"], timeout_seconds: 10 } };
const base: MigrationRecovery = { runId: "run-1", step: migration, deadline: 50_000, now: 20_000, observation: "unobserved" };
const decide = (change: Partial<MigrationRecovery>) => decideMigrationRecovery({ ...base, ...change });

test("recovery inspects a stable migration identity before making any effect", () => {
  assert.deepEqual(decide({}), { kind: "observe-migration", runId: "run-1", stepId: "schema" });
  assert.equal(decide({ observation: "unavailable" }).kind, "intervention");
  assert.equal(decide({ observation: "running" }).kind, "wait-migration");
  assert.equal(decide({ observation: "running", now: 50_000 }).kind, "intervention");
  assert.equal(decide({ observation: "succeeded", now: 60_000 }).kind, "applied");
});

test("only replay-safe migrations retry, never beyond the recorded deadline", () => {
  const safe: Migration = { ...migration, recovery: { kind: "replay-safe" } };
  assert.deepEqual(decide({ step: safe, observation: "failed" }), { kind: "retry-migration", runId: "run-1", stepId: "schema", deadline: 50_000 });
  assert.equal(decide({ step: safe, observation: "unobserved" }).kind, "observe-migration");
  assert.equal(decide({ step: safe, observation: "running" }).kind, "wait-migration");
  assert.equal(decide({ step: safe, observation: "missing", now: 50_000 }).kind, "intervention");
  assert.equal(decide({ step: safe, observation: "failed", now: 60_000 }).kind, "intervention");
});

test("probe intent is persisted once and observed before starting; outcome determines the next step", () => {
  assert.deepEqual(decide({ observation: "failed" }), { kind: "record-probe-intent", runId: "run-1", stepId: "schema", deadline: 30_000 });
  assert.equal(decide({ observation: "missing", probe: { deadline: 30_000, observation: "unobserved" } }).kind, "observe-probe");
  assert.equal(decide({ observation: "failed", probe: { deadline: 30_000, observation: "missing" } }).kind, "intervention");
  assert.equal(decide({ observation: "failed", probe: { deadline: 30_000, observation: "running" } }).kind, "wait-probe");
  assert.equal(decide({ observation: "failed", probe: { deadline: 30_000, observation: "applied" } }).kind, "applied");
  assert.equal(decide({ observation: "failed", probe: { deadline: 30_000, observation: "not-applied" } }).kind, "intervention");
  assert.equal(decide({ observation: "failed", probe: { deadline: 30_000, observation: "unknown" } }).kind, "intervention");
  assert.equal(decide({ observation: "failed", probe: { deadline: 30_000, observation: "unavailable" } }).kind, "intervention");
  assert.equal(decide({ observation: "failed", now: 30_000, probe: { deadline: 30_000, observation: "missing" } }).kind, "intervention");
  assert.equal(decide({ observation: "failed", now: 31_000, probe: { deadline: 30_000, observation: "running" } }).kind, "intervention");
  assert.equal(decide({ observation: "unobserved", probe: { deadline: 30_000, observation: "applied" } }).kind, "observe-migration");
});

test("diagnostic probes retain independent persisted deadlines after migration expiration", () => {
  assert.deepEqual(decide({ observation: "failed", now: 55_000 }), { kind: "record-probe-intent", runId: "run-1", stepId: "schema", deadline: 65_000 });
  assert.equal(decide({ observation: "failed", now: 65_000, probe: { deadline: 65_000, observation: "missing" } }).kind, "intervention");
  assert.equal(decide({ deadline: Number.NaN }).kind, "intervention");
  assert.equal(decide({ observation: "failed", probe: { deadline: Number.POSITIVE_INFINITY, observation: "missing" } }).kind, "intervention");
});

test("a missing replay-safe migration remains ambiguous before its deadline", () => {
  const safe: Migration = { ...migration, recovery: { kind: "replay-safe" } };
  assert.equal(decide({ step: safe, observation: "missing" }).kind, "intervention");
});


test("fresh recovery records a probe intent, but missing evidence after restart is ambiguous", () => {
  const fresh = decide({ observation: "failed" });
  assert.deepEqual(fresh, { kind: "record-probe-intent", runId: "run-1", stepId: "schema", deadline: 30_000 });
  assert.equal(decide({ observation: "failed", probe: { deadline: 30_000, observation: "missing" } }).kind, "intervention");
});
