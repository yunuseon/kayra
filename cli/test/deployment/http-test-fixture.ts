import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { parseApplicationPlan } from "../../src/contracts/application-plan.ts";
import type { HttpPlanPort } from "../../src/contracts/http-plan.ts";
import type { HostObserver } from "../../src/contracts/resource-authority.ts";
import type { BuildPorts } from "../../src/contracts/build-artifact.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { createLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";

const parsed = parseApplicationPlan(JSON.parse(readFileSync(new URL("../../../ci/tests/swarm-http/native-plan.json", import.meta.url), "utf8")));
assert.ok(parsed.ok);
export const template = parsed.value;
const web = template.services["web"];
assert.ok(web !== undefined);
export const commit = "a".repeat(40);
export const generation = "22222222-2222-4222-8222-222222222222";
// eslint-disable-next-line functional/prefer-immutable-types -- test cleanup context
export const fixture = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "kayra-http-operation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "index");
  const artifacts = await openArtifactStore(join(root, "artifacts"));
  const index = await createLifecycleAppIndex(path, (identity) => Promise.resolve({ ...identity, status: "applied" }));
  t.after(() => index.close());
  await index.prepareApp("shop");
  const ticket = await index.reserveRegistration("shop", generation, "swarm");
  await index.submitRegistration("shop", ticket, generation);
  await index.reconcileRegistration("shop", ticket, generation);
  const builds: BuildPorts = { ...artifacts, now: () => 1000, images: () => [], prepare: () => Promise.resolve('{"fixture":"retained"}') };
  const ports: HttpPlanPort & HostObserver & Pick<BuildPorts, "read" | "retain" | "now"> = {
    ...artifacts, now: () => 1000,
    preview: (registration, _runtime, sha, artifact) => Promise.resolve({ ...template, app: registration.app, registration, commit: sha, artifact, routes: template.routes.map((route) => ({ ...route, host: `${registration.app}.lab.test` })), services: { web: { ...web, image: `localhost:5000/${registration.app}/web@sha256:${"d".repeat(64)}` } } }),
    observeHost: (host) => Promise.resolve({ status: "ready", engine: "29.9.3", api: "1.56", node: host.node, cluster: host.cluster, network: host.network.id,
      capacity: { cpu: host.profile.cpu_millicores, memory: host.profile.memory_bytes }, standing: { cpu: host.profile.platform_cpu_millicores, memory: host.profile.platform_memory_bytes } }),
  };
  return { path, artifacts, index, ports, builds };
};

