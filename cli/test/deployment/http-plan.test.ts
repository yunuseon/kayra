import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stringify } from "yaml";
import { parseIndexedApp } from "../../src/contracts/app-registration.ts";
import type { HttpArtifact, HttpPlanScope } from "../../src/contracts/http-plan.ts";
import { parseRegistrationGeneration } from "../../src/contracts/registration-generation.ts";
import { parseRollout } from "../../src/contracts/rollout.ts";
import { parseSwarmAuthority } from "../../src/contracts/swarm-authority.ts";
import { compileHttpPlan } from "../../src/server/deployment/http-plan.ts";
import { describeCompose } from "../../src/server/runtime/compose-description.ts";

const content = readFileSync(new URL("../../../ci/tests/swarm-http/compose.yml", import.meta.url), "utf8");
const files = [{ path: "deploy/compose.yml", content }];
const registration = parseRegistrationGeneration({ version: 1, app: "shop", incarnation: "11111111-1111-4111-8111-111111111111", actionId: "11111111-1111-4111-8111-111111111111:1", registrationGeneration: "22222222-2222-4222-8222-222222222222" });
const app = parseIndexedApp("shop", { name: "shop", repo: "https://example.invalid/shop.git", path: ".", ref: "main", runtime: "swarm", hosts: ["www.lab.test"], secrets: ["GREETING"], grants: { memory_bytes: 256 * 1024**2, cpu_millicores: 500, maintenance: false } });
const authorityInput: unknown = JSON.parse(readFileSync(new URL("../../../ci/tests/swarm-host/authority.json", import.meta.url), "utf8"));
const authority = parseSwarmAuthority(authorityInput);
const rollout = parseRollout({ strategy: "rolling", mixed_version_compatible: true, rollback_compatible: true, services: { web: { role: "http", overlap: "allowed" } } });
const description = describeCompose(files);
assert.ok(registration.ok && app.ok && authority.ok && rollout.ok && description.ok);
const scope: HttpPlanScope = { registration: registration.value, app: app.value, authority: authority.value, runtime: "swarm", domain: "lab.test", configuration: { identity: "sha256:" + "c".repeat(64), keys: ["MODE"] } };
const artifact: HttpArtifact = { artifact: "b".repeat(64), sha: "a".repeat(40), registration: registration.value, rollout: rollout.value, images: [{ variable: "WEB_IMAGE", ref: "localhost:5000/shop/web@sha256:" + "d".repeat(64) }], routes: [{ host: "www", service: "web", port: 8080, path: undefined, check: "/", rateLimit: undefined }] };

const document = (service: Readonly<Record<string, unknown>>) => [{ path: "compose.yml", content: stringify({ services: { web: service } }) }];
const base = {
  image: "${WEB_IMAGE:?}", environment: { MODE: "${MODE}", GREETING: "${GREETING}" },
  deploy: { resources: { limits: { memory: "64m", cpus: "0.1" }, reservations: { memory: "32m", cpus: "0.05" } } },
  healthcheck: { test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"], interval: "1s", timeout: "1s" },
};

test("HTTP proposals preserve immutable artifact/authority and bind inputs without resolving secrets", () => {
  const compiled = compileHttpPlan(scope, artifact, description.value);
  assert.ok(compiled.ok);
  const plan = compiled.value;
  assert.equal(plan.runtime, "swarm");
  assert.deepEqual(plan.registration, scope.registration);
  assert.equal(plan.artifact, artifact.artifact);
  assert.deepEqual(plan.policy, { version: 1, failureMonitorSeconds: 30, updateTimeoutSeconds: 90, rollbackTimeoutSeconds: 90 });
  assert.deepEqual(plan.services["web"]?.environment, { MODE: { kind: "configuration", key: "MODE" }, GREETING: { kind: "secret", key: "GREETING" }, LITERAL: { kind: "literal", value: "$HOME" } });
  assert.deepEqual(plan.services["web"].resources, { memoryBytes: 67108864, reserveMemoryBytes: 33554432, nanoCpus: 100000000, reserveNanoCpus: 50000000 });
  assert.equal(plan.services["web"].stopGraceSeconds, 30);
  assert.deepEqual(plan.routes, [{ host: "www.lab.test", service: "web", port: 8080, path: null, check: "/", rateLimit: null }]);
  assert.ok(Object.isFrozen(plan.services));
  assert.ok(Object.isFrozen(plan.services["web"].environment));
  assert.ok(Object.isFrozen(plan.rollout.services));
  assert.equal(description.value.services["web"]?.environment["GREETING"], "${GREETING:?required}");
});

test("description refuses unsafe or unsupported Compose before reading host files or running Docker", () => {
  for (const [field, value] of [["ports", ["80:8080"]], ["volumes", ["/:/host"]], ["env_file", "/run/platform-secrets/token"], ["extends", { file: "/run/platform-secrets/token", service: "web" }], ["build", "."], ["labels", { "traefik.enable": true }], ["network_mode", "host"], ["depends_on", { web: { condition: "service_healthy" } }]] as const) {
    const result = describeCompose(document({ ...base, [field]: value }));
    assert.equal(result.ok, false, field);
    assert.match(result.error, /unsupported Compose field/);
  }
  for (const field of ["include", "volumes", "configs", "secrets", "name", "version"]) {
    const result = describeCompose([{ path: "compose.yml", content: stringify({ [field]: "/run/platform-secrets/token", services: { web: base } }) }]);
    assert.equal(result.ok, false);
    assert.match(result.error, /unsupported Compose field/);
  }
  assert.equal(describeCompose([...files, ...files]).ok, false);
  assert.equal(describeCompose([{ ...files[0], path: "../outside", content }]).ok, false);
  assert.equal(describeCompose([{ path: "compose.yml", content: "services: {}\nservices: {}\n" }]).ok, false);
  assert.equal(describeCompose([{ path: "compose.yml", content: "#".repeat(256 * 1024 + 1) }]).ok, false);
});

test("resource and health normalization rejects omitted semantics, host inheritance and contradictory budgets", () => {
  for (const service of [
    { ...base, environment: ["MODE"] }, { ...base, environment: { MODE: null } }, { ...base, deploy: undefined },
    { ...base, deploy: { ...base.deploy, replicas: 2 } }, { ...base, deploy: { ...base.deploy, update_config: { order: "stop-first" } } },
    { ...base, deploy: { resources: { ...base.deploy.resources, reservations: { memory: "128m", cpus: "0.05" } } } },
    { ...base, deploy: { resources: { ...base.deploy.resources, reservations: { memory: "32m", cpus: "0.2" } } } },
    { ...base, healthcheck: { ...base.healthcheck, disable: true } }, { ...base, healthcheck: { test: ["CMD-SHELL", "echo ok"] } },
    { ...base, healthcheck: { ...base.healthcheck, interval: "1ms" } }, { ...base, command: "echo host-like shell syntax" },
    { ...base, command: ["sh", "-c", "echo $MODE"] }, { ...base, networks: ["platform-swarm"] },
  ]) assert.equal(describeCompose(document(service)).ok, false);
  const exact = describeCompose(document({ ...base, deploy: { resources: { limits: { memory: 67108864, cpus: "0.123456789" }, reservations: { memory: "32mb", cpus: "0.000000001" } } } }));
  assert.ok(exact.ok);
  assert.equal(exact.value.services["web"]?.resources.nanoCpus, 123456789);
  assert.equal(exact.value.services["web"].resources.reserveNanoCpus, 1);
});

test("proposal admission refuses wrong ownership, undeclared bindings, grants and unsupported roles", () => {
  assert.equal(compileHttpPlan({ ...scope, runtime: "compose" }, artifact, description.value).ok, false);
  assert.equal(compileHttpPlan(scope, { ...artifact, registration: { ...registration.value, actionId: registration.value.incarnation + ":2" } }, description.value).ok, false);
  assert.equal(compileHttpPlan({ ...scope, app: { ...app.value, hosts: ["other.lab.test"] } }, artifact, description.value).ok, false);
  assert.equal(compileHttpPlan(scope, { ...artifact, rollout: undefined }, description.value).ok, false);
  for (const ref of ["localhost:5000/other/web@sha256:" + "d".repeat(64), "localhost:5000/shop/../other@sha256:" + "d".repeat(64), "localhost:5000/shop/web:tag"]) assert.equal(compileHttpPlan(scope, { ...artifact, images: [{ variable: "WEB_IMAGE", ref }] }, description.value).ok, false);
  assert.equal(compileHttpPlan(scope, { ...artifact, images: [...artifact.images, ...artifact.images] }, description.value).ok, false);
  for (const value of ["${UNKNOWN:?}", "${MODE:-fallback}", "prefix-${MODE}"]) {
    const changed = describeCompose(document({ ...base, environment: { MODE: value } }));
    assert.ok(changed.ok);
    assert.equal(compileHttpPlan(scope, artifact, changed.value).ok, false);
  }
  assert.equal(compileHttpPlan({ ...scope, app: { ...app.value, runtime: "swarm", grants: { memory_bytes: 63 * 1024**2, cpu_millicores: 500, maintenance: false } } }, artifact, description.value).ok, false);
  const worker = parseRollout({ ...rollout.value, services: { web: { role: "worker", overlap: "forbidden" } } });
  assert.ok(worker.ok);
  assert.equal(compileHttpPlan(scope, { ...artifact, rollout: worker.value }, description.value).ok, false);
  const maintenance = parseRollout({ ...rollout.value, strategy: "maintenance", mixed_version_compatible: false, rollback_compatible: false });
  assert.ok(maintenance.ok);
  assert.equal(compileHttpPlan(scope, { ...artifact, rollout: maintenance.value }, description.value).ok, false);
});
