import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseApplicationPlan } from "../../src/contracts/application-plan.ts";
import { parseRolloutPlan, rolloutOperationSeconds, rolloutPlanDigest, rolloutWorkloadDigest } from "../../src/contracts/rollout-plan.ts";
import { parseIndexedApp } from "../../src/contracts/app-registration.ts";
import type { HttpArtifact, HttpPlanScope } from "../../src/contracts/http-plan.ts";
import type { ComposeDescription } from "../../src/contracts/compose-description.ts";
import { compileHttpPlan } from "../../src/server/deployment/http-plan.ts";
import { compileRolloutPlan, rolloutMigrationSequence } from "../../src/server/deployment/rollout-plan.ts";
import { renderNativeHttp } from "../../src/server/runtime/swarm-service.ts";
import { typed } from "../../src/lib/typed.ts";

const input: unknown = JSON.parse(readFileSync(new URL("../../../ci/tests/swarm-http/native-plan.json", import.meta.url), "utf8"));
const parsed = parseApplicationPlan(input); assert.ok(parsed.ok); const workload = parsed.value; const spec = workload.services["web"]; assert.ok(spec);
const migration = { id: "schema", service: "web", command: ["node", "migrate.mjs"], timeout_seconds: 30, recovery: { kind: "replay-safe" as const } };
const candidate = () => ({ version: 2, runtime: "swarm", workload, rollout: { ...workload.rollout, migrations: [migration] },
  policy: { version: 1, migrationTimeoutCeilingSeconds: 90, schedulingSeconds: 90, cleanupSeconds: 30, maximumAttempts: 8 } });

test("full rollout metadata stays distinct from an independently validated HTTP workload projection", () => {
  const result = parseRolloutPlan(candidate()); assert.ok(result.ok); const plan = result.value;
  assert.equal(plan.rollout.migrations.length, 1); assert.equal(plan.workload.rollout.migrations.length, 0);
  assert.ok(parseApplicationPlan(plan.workload).ok); assert.equal(parseApplicationPlan(plan).ok, false);
  assert.notEqual(rolloutPlanDigest(plan), rolloutWorkloadDigest(plan));
  const action = { app: workload.app, service: "web", incarnation: workload.registration.incarnation, action: workload.registration.incarnation + ":2", effect: "apply" as const,
    deadline: 10000, plan: rolloutWorkloadDigest(plan) };
  const env = { RELEASE: "A", TOKEN: "secret-value" };
  assert.deepEqual(renderNativeHttp(plan.workload, action, env, {}), renderNativeHttp(workload, action, env, {}));
  assert.throws(() => renderNativeHttp(plan.workload, { ...action, plan: rolloutPlanDigest(plan) }, env, {}), /immutable plan/);
});

test("unsupported requirements and mismatched projections fail before admitting a rollout", () => {
  const source = candidate();
  assert.equal(parseRolloutPlan({ ...source, workload: { ...workload, rollout: source.rollout } }).ok, false);
  assert.equal(parseRolloutPlan({ ...source, policy: { ...source.policy, migrationTimeoutCeilingSeconds: 29 } }).ok, false);
  assert.equal(parseRolloutPlan({ ...source, rollout: { ...source.rollout, migrations: [{ ...migration, service: "other" }] } }).ok, false);
  assert.equal(parseRolloutPlan({ ...source, rollout: { ...source.rollout, services: { web: { role: "worker", overlap: "forbidden" } } } }).ok, false);
  assert.equal(parseRolloutPlan({ ...source, workload: { ...workload, services: { web: { ...spec, stopGraceSeconds: 60 } } } }).ok, false);
});

test("migration descriptions bind logical run, whole deployment and immutable materialization references", () => {
  const result = parseRolloutPlan(candidate()); assert.ok(result.ok);
  const run = "00000000-0000-4000-8000-000000000001"; const sequence = rolloutMigrationSequence(result.value, run); assert.ok(sequence.ok);
  assert.equal(sequence.value.scope.run, run); assert.equal(sequence.value.deployment, rolloutPlanDigest(result.value));
  assert.deepEqual(sequence.value.steps[0]?.template.environment, spec.environment);
  assert.equal(sequence.value.steps[0].template.image, spec.image);
  assert.deepEqual(sequence.value.steps[0].template.networks, [workload.host.network.id]);
  assert.ok(!JSON.stringify(sequence.value).includes("secret-value"));
  assert.ok(rolloutOperationSeconds(result.value) >= 90 + 30 + 30 + 90 + 90);
});

const app = parseIndexedApp(workload.app, { name: workload.app, repo: "https://example.invalid/shop.git", path: ".", ref: "main", runtime: "swarm",
  hosts: ["native.lab.test"], secrets: ["TOKEN"], grants: workload.grants }); assert.ok(app.ok);
const scope = typed<HttpPlanScope>({ registration: workload.registration, app: app.value, authority: workload.host, runtime: "swarm", domain: "lab.test",
  configuration: { identity: workload.configurationIdentity, keys: [] } });
const sourceArtifact = typed<HttpArtifact>({ artifact: workload.artifact, sha: workload.commit, registration: workload.registration,
  rollout: { ...workload.rollout, migrations: [migration] }, images: [{ variable: "WEB_IMAGE", ref: spec.image }],
  routes: [{ host: "native", service: "web", port: 8080, path: undefined, check: "/", rateLimit: undefined }] });
const description = typed<ComposeDescription>({ services: { web: { ...spec, image: "${WEB_IMAGE}", environment: { RELEASE: "A", TOKEN: "${TOKEN}" } } } });

test("legacy HTTP admission still rejects migrations while the complete-plan compiler preserves them", () => {
  assert.equal(compileHttpPlan(scope, sourceArtifact, description).ok, false);
  const compiled = compileRolloutPlan(scope, sourceArtifact, description, 90); assert.ok(compiled.ok);
  assert.deepEqual(compiled.value.rollout.migrations, [migration]); assert.equal(compiled.value.workload.rollout.migrations.length, 0);
  assert.equal(compileRolloutPlan(scope, sourceArtifact, description, 29).ok, false);
  assert.equal(compileRolloutPlan({ ...scope, runtime: "compose" }, sourceArtifact, description, 90).ok, false);
});
