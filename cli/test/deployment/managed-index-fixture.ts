/* eslint-disable functional/no-let, functional/prefer-immutable-types -- owns filesystem fixtures, clocks and the currently open app-index writer */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { parseRegistrationInfrastructure } from "../../src/contracts/registration-infrastructure.ts";
import { compileManagedApplicationPlan } from "../../src/server/deployment/managed-application-plan.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import type { IndexedManagedRuntime } from "../../src/server/deployment/indexed-managed-lifecycle.ts";
import { typed } from "../../src/lib/typed.ts";

export const managedIndexFixture = async (t: TestContext, journals = openJournal) => {
  const path = await mkdtemp(join(tmpdir(), "kayra-managed-index-")); const directory = join(path, "index"); const artifacts = await openArtifactStore(join(path, "artifacts")); const data = await managedPlanFixture();
  const observer = (expected: { readonly app: string; readonly incarnation: string; readonly actionId: string; readonly registrationGeneration: string }) => Promise.resolve({ ...expected, status: "applied" });
  let index = await createLifecycleAppIndex(directory, observer, journals); let clock = 1000; let allowed = true; let hostCalls = 0;
  t.after(async () => { await index.close(); await rm(path, { recursive: true, force: true }); });
  const incarnation = await index.prepareApp("shop", "managed-v3"); const generation = randomUUID(); const ticket = await index.reserveRegistration("shop", generation, "swarm"); await index.submitRegistration("shop", ticket, generation); await index.reconcileRegistration("shop", ticket, generation);
  const registration = await index.verifiedRegistration("shop"); const ownership = await index.dataOwnership("shop"); const volumes = await index.reserveDataVolumeIdentities("shop", ["database"]);
  const infrastructure = parseRegistrationInfrastructure({ ...data.scope.infrastructure, registration, ownership, overlay: { ...data.scope.infrastructure.overlay, scope: { ...data.scope.infrastructure.overlay.scope, incarnation, name: "kayra-app-" + incarnation } } }); assert.ok(infrastructure.ok);
  const payload = JSON.stringify({ ...data.artifact, registration });
  const build = await index.prepareBuild("shop", data.artifact.sha, { ...artifacts, now: () => clock, prepare: () => Promise.resolve(payload), images: () => data.artifact.images.map((image) => image.ref) });
  const compiled = compileManagedApplicationPlan({ ...data.scope, registration, infrastructure: infrastructure.value, volumes }, { ...data.artifact, registration, artifact: build.artifact }, data.description); assert.ok(compiled.ok);
  const plan = compiled.value; const source = parseManagedLifecycleSource({ version: 1, candidate: plan, previous: null, retained: [], retired: [], run: randomUUID(), action: incarnation + ":2", createdAt: clock });
  const unreachable = () => Promise.reject(new Error("unstarted index fixture must not invoke workloads"));
  const runtime = typed<IndexedManagedRuntime>({ ...artifacts, now: () => clock, requestAllowed: () => Promise.resolve(allowed), authorize: () => Promise.resolve(allowed),
    observeHost: (host) => { hostCalls++; return Promise.resolve({ status: "ready", engine: "fixture", api: "1.57", node: host.node, cluster: host.cluster, network: host.network.id, capacity: { cpu: host.profile.cpu_millicores, memory: host.profile.memory_bytes }, standing: { cpu: host.profile.platform_cpu_millicores, memory: host.profile.platform_memory_bytes } }); },
    services: { observe: unreachable, observeDesired: unreachable, apply: unreachable, tombstone: unreachable }, jobs: { observe: unreachable, create: unreachable, start: unreachable, fence: unreachable }, readiness: { check: unreachable },
  });
  return { path, directory, source, plan, runtime, incarnation, ownership, volumes, artifacts, index: () => index, hostCalls: () => hostCalls, clock: (value: number) => { clock = value; }, deny: () => { allowed = false; },
    reopen: async () => { await index.close(); index = await openLifecycleAppIndex(directory, observer, journals); },
  };
};
