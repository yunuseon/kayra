import { strict as assert } from "node:assert";
import { test } from "node:test";
import { stringify } from "yaml";
import { describeCompose } from "../../src/server/runtime/compose-description.ts";
import { describeManagedCompose } from "../../src/server/runtime/managed-compose-description.ts";

const service = {
  image: "${WEB_IMAGE:?}",
  deploy: { resources: { limits: { memory: "128m", cpus: "0.25" }, reservations: { memory: "64m", cpus: "0.125" } } },
  healthcheck: { test: ["CMD", "/health"], interval: "2s", timeout: "1s" },
};
const document = (root: unknown) => [{ path: "deploy/compose.yml", content: stringify(root) }];
const fixture = {
  services: { web: { ...service, depends_on: { db: { condition: "service_healthy" } } }, db: { ...service, volumes: ["data:/var/lib/db"] } },
  volumes: { data: {} },
};

test("managed description retains logical data mounts and readiness dependencies without physical volume names", () => {
  const result = describeManagedCompose(document(fixture)); assert.ok(result.ok);
  const db = result.value.services["db"]; const web = result.value.services["web"]; assert.ok(db && web);
  assert.deepEqual(result.value.volumes, ["data"]);
  assert.deepEqual(db.mounts, [{ volume: "data", target: "/var/lib/db", readOnly: false, noCopy: false }]);
  assert.deepEqual(web.dependencies, [{ service: "db", condition: "healthy" }]);
  assert.equal(db.resources.memoryBytes, 134217728);
  assert.ok(Object.isFrozen(web.dependencies)); assert.ok(Object.isFrozen(result.value.services));
  assert.equal(describeCompose(document(fixture)).ok, false);
  assert.equal(describeCompose(document({ services: { web: { ...service, depends_on: ["db"] }, db: service } })).ok, false);
});

test("short and long mounts normalize read-only and no-copy without silently dropping options", () => {
  const result = describeManagedCompose(document({ services: { web: { ...service, volumes: ["shared:/data:ro", { type: "volume", source: "other", target: "/other", read_only: false, volume: { nocopy: true } }] } }, volumes: { other: null, shared: {} } }));
  assert.ok(result.ok); assert.deepEqual(result.value.services["web"]?.mounts, [
    { volume: "shared", target: "/data", readOnly: true, noCopy: false }, { volume: "other", target: "/other", readOnly: false, noCopy: true },
  ]);
});

test("managed mounts reject host access, anonymous storage, ambiguous paths and ignored options", () => {
  for (const value of [
    ["/host:/data"], ["./data:/data"], ["/data"], ["data:/data:cached"], ["data:/data:ro,z"], ["unknown:/data"],
    ["data:/"], ["data:/data/"], ["data:/data/../other"], ["data:/data//other"], ["data:/proc/a"], ["data:relative"], ["data:/da$ta"],
    [{ type: "bind", source: "data", target: "/data" }], [{ type: "volume", source: "data", target: "/data", consistency: "cached" }],
    [{ type: "volume", source: "data", target: "/data", volume: { subpath: "a" } }],
    [{ type: "volume", source: "data", target: "/data", read_only: "false" }],
    ["data:/data", "data:/data/nested"], ["data:/data", "data:/data"],
  ]) assert.equal(describeManagedCompose(document({ services: { db: { ...service, volumes: value } }, volumes: { data: {} } })).ok, false, JSON.stringify(value));
  for (const declaration of [{ external: true }, { name: "existing" }, { driver: "local" }, { driver_opts: { device: "/" } }]) {
    assert.equal(describeManagedCompose(document({ ...fixture, volumes: { data: declaration } })).ok, false);
  }
  assert.equal(describeManagedCompose(document({ ...fixture, volumes: { data: {}, unused: {} } })).ok, false);
});

test("dependency graph rejects missing targets, self cycles and indirect cycles", () => {
  for (const services of [
    { web: { ...service, depends_on: ["missing"] } },
    { web: { ...service, depends_on: ["web"] } },
    { web: { ...service, depends_on: ["worker"] }, worker: { ...service, depends_on: ["db"] }, db: { ...service, depends_on: ["web"] } },
  ]) assert.equal(describeManagedCompose(document({ services })).ok, false);
  const result = describeManagedCompose(document({ services: { web: { ...service, depends_on: ["worker", "db"] }, worker: { ...service, depends_on: { db: { condition: "service_started", restart: false, required: true } } }, db: service } }));
  assert.ok(result.ok); assert.deepEqual(result.value.services["worker"]?.dependencies, [{ service: "db", condition: "started" }]);
});

test("dependency features with unimplemented effects fail rather than being ignored", () => {
  for (const depends_on of [["db", "db"], { db: {} }, { db: { condition: "service_completed_successfully" } }, { db: { condition: "service_started", required: false } }, { db: { condition: "service_started", restart: true } }, { db: { condition: "service_started", unknown: true } }]) {
    assert.equal(describeManagedCompose(document({ services: { web: { ...service, depends_on }, db: service } })).ok, false);
  }
});

test("managed description preserves existing health, budgets, network, host and YAML restrictions", () => {
  for (const changed of [{ ...service, ports: ["80:80"] }, { ...service, deploy: {} }, { ...service, healthcheck: { disable: true } }, { ...service, networks: ["host"] }, { ...service, env_file: "/etc/secrets" }]) {
    assert.equal(describeManagedCompose(document({ services: { web: changed } })).ok, false);
  }
  assert.equal(describeManagedCompose(document({ services: { web: service }, configs: {} })).ok, false);
  assert.equal(describeManagedCompose([{ path: "compose.yml", content: "services: {}\nservices: {}\n" }]).ok, false);
  assert.equal(describeManagedCompose([{ path: "../compose.yml", content: "services: {}" }]).ok, false);
  assert.equal(describeManagedCompose([{ path: "compose.yml", content: "#".repeat(262145) }]).ok, false);
});
