import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseIndexedApp } from "../../src/contracts/app-registration.ts";
import { parseSwarmAuthority } from "../../src/contracts/swarm-authority.ts";
import { parseRegistrationInfrastructure } from "../../src/contracts/registration-infrastructure.ts";
import { ownedVolume } from "../../src/contracts/owned-volume.ts";
import { compileManagedApplicationPlan } from "../../src/server/deployment/managed-application-plan.ts";

export const managedPlanFixture = async () => {
  const raw: unknown = JSON.parse(await readFile(new URL("../../../ci/tests/swarm-host/authority.json", import.meta.url), "utf8")); const authority = parseSwarmAuthority(raw); assert.ok(authority.ok);
  const incarnation = randomUUID(); const registration = { version: 1, app: "shop", incarnation, actionId: incarnation + ":1", registrationGeneration: randomUUID() } as const;
  const ownership = { version: 1, app: "shop", incarnation, dataOwner: randomUUID() } as const;
  const infrastructure = parseRegistrationInfrastructure({ version: 1, runtime: "swarm", registration, ownership, overlay: { scope: { version: 1, app: "shop", incarnation, node: authority.value.node, cluster: authority.value.cluster, name: `kayra-app-${incarnation}` }, id: "p".repeat(25) } }); assert.ok(infrastructure.ok);
  const app = parseIndexedApp("shop", { name: "shop", runtime: "swarm", repo: "https://example.invalid/owner/shop.git", ref: "main", path: ".", hosts: ["www.lab.test"], secrets: ["TOKEN"], grants: { memory_bytes: 536870912, cpu_millicores: 1000, maintenance: false } }); assert.ok(app.ok);
  const volume = ownedVolume("shop", ownership.dataOwner, randomUUID(), "database"); assert.ok(volume.ok);
  const images = ["web", "database"].map((name) => ({ source: `localhost:5000/shop/${name}@sha256:${"a".repeat(64)}`, pull: `localhost:5000/shop/${name}@sha256:${"b".repeat(64)}`, os: "linux", architecture: "arm64" } as const));
  const capabilities = ["rolling-http", "workers", "singleton", "retained-dependency", "migrations", "checks", "maintenance"] as const;
  const scope = { registration, runtime: "swarm", app: app.value, authority: authority.value, domain: "lab.test", configuration: { identity: "sha256:" + "c".repeat(64), keys: ["MODE"] }, infrastructure: infrastructure.value, volumes: [volume.value], images, capabilities, migrationTimeoutCeilingSeconds: 300 } as const;
  const base = { environment: {}, command: null, entrypoint: null, resources: { memoryBytes: 33554432, reserveMemoryBytes: 16777216, nanoCpus: 100000000, reserveNanoCpus: 50000000 }, health: { command: ["CMD", "/health"], intervalSeconds: 2, timeoutSeconds: 1, startPeriodSeconds: 5, retries: 2 }, stopGraceSeconds: 30, mounts: [], dependencies: [] };
  const description = { services: {
    web: { ...base, image: "${WEB_IMAGE}", environment: { TOKEN: "${TOKEN}", MODE: "${MODE:?required}", LITERAL: "$$welcome" }, dependencies: [{ service: "db", condition: "healthy" }] },
    worker: { ...base, image: "${WEB_IMAGE}", dependencies: [{ service: "db", condition: "healthy" }] },
    db: { ...base, image: "${DATABASE_IMAGE}", mounts: [{ volume: "database", target: "/var/lib/database", readOnly: false, noCopy: true }] },
  }, volumes: ["database"] } as const;
  const rollout = { strategy: "rolling", mixed_version_compatible: true, rollback_compatible: true,
    services: { web: { role: "http", overlap: "allowed" }, worker: { role: "worker", overlap: "forbidden" }, db: { role: "retained-dependency", overlap: "forbidden" } },
    migrations: [{ id: "schema", service: "web", command: ["/migrate"], timeout_seconds: 30, recovery: { kind: "replay-safe" } }], checks: [],
  } as const;
  const artifact = { registration, sha: "d".repeat(40), artifact: "e".repeat(64), rollout, images: images.map((image, index) => ({ variable: index === 0 ? "WEB_IMAGE" : "DATABASE_IMAGE", ref: image.source })),
    routes: [{ host: "www", service: "web", port: 8080, path: undefined, check: "/health", rateLimit: undefined }],
  };
  const compiled = compileManagedApplicationPlan(scope, artifact, description); assert.ok(compiled.ok, compiled.ok ? "" : compiled.error);
  return { scope, artifact, description, plan: compiled.value };
};
