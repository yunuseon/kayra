/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types -- accepts mutable test context and models app services and native one-shot outcomes, not coordinator state */
import { strict as assert } from "node:assert";
import type { TestContext } from "node:test";
import { managedIndexFixture } from "./managed-index-fixture.ts";
import { jobRuntime } from "./one-shot-fixture.ts";
import { jobName } from "../../src/contracts/one-shot-job.ts";
import type { JobPlan } from "../../src/contracts/one-shot-job.ts";
import type { ServiceObservation } from "../../src/contracts/swarm-service.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedWorkloadPort } from "../../src/contracts/managed-workloads.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import type { IndexedManagedRuntime } from "../../src/server/deployment/indexed-managed-lifecycle.ts";
import { typed } from "../../src/lib/typed.ts";

export const managedIndexRuntimeFixture = async (t: TestContext, failMigration = false) => {
  const lab = await managedIndexFixture(t); const candidate = parseManagedApplicationPlan({ ...lab.plan, rollout: { ...lab.plan.rollout, migrations: lab.plan.rollout.migrations.map((step) => ({ ...step, recovery: { kind: "status-probe", command: ["/status"], timeout_seconds: 10 } })) } }); assert.ok(candidate.ok);
  const source = parseManagedLifecycleSource({ ...lab.source, candidate: candidate.value }); const services = new Map<string, ServiceObservation>(); const jobs = new Map<string, ReturnType<typeof jobRuntime>>();
  const node = (job: JobPlan) => { const key = jobName(job.scope); let value = jobs.get(key); if (value === undefined) { value = jobRuntime(job); jobs.set(key, value); } return value; };
  const unreachable = () => Promise.reject(new Error("unexpected workload cleanup"));
  const workloads = typed<ManagedWorkloadPort>({
    observe: (scope) => Promise.resolve(services.get(scope.service) ?? { status: "absent" }),
    observeDesired: (action, spec) => { const value = services.get(action.service); return Promise.resolve(value?.status === "owned" ? { ...value, specMatches: value.plan === managedServiceDigest(spec) } : { status: "absent" }); },
    apply: async (action, expected) => {
      assert.equal((await lab.index().resourceSnapshot())?.charges[0]?.result, "pending"); const before = services.get(action.service); assert.equal(expected?.version ?? null, before?.status === "owned" ? before.version : null);
      services.set(action.service, { status: "owned", id: action.service.padEnd(25, "s"), version: before?.status === "owned" ? before.version + 1 : 1, action: action.action, effect: action.effect, taskEffect: action.effect, plan: action.plan, taskPlan: action.plan, specMatches: true, tombstone: false, retainedInputsCleared: false, containersStopped: false, containersConverged: true, replicas: 1, endpoint: "vip", update: "completed", tasks: [{ id: action.service.padEnd(25, "t"), incarnation: action.incarnation, action: action.action, effect: action.effect, plan: action.plan, desired: "running", state: "running", health: "healthy" }] }); return "acknowledged";
    }, tombstone: unreachable, fence: unreachable,
  });
  const runtime = typed<IndexedManagedRuntime>({ ...lab.runtime, services: workloads,
    jobs: {
      observe: async (job) => { const value = await node(job).native.observe(job); return value.status === "owned" && value.state === "succeeded" && job.scope.purpose === "probe" ? { ...value, probe: "unknown" } : value; },
      create: (job) => node(job).native.create(job, Object.fromEntries(Object.entries(job.environment).map(([key, value]) => [key, value.kind === "literal" ? value.value : "INDEX_PRIVATE_VALUE"]))),
      start: async (job, id, deadline) => { const value = await node(job).native.start(job, id, deadline); if (failMigration && job.scope.purpose === "migration") node(job).state("exited", 1); return value; },
      fence: (job, id, deadline) => node(job).native.fence(job, id, deadline),
    },
    readiness: { check: (action) => Promise.resolve({ app: action.app, incarnation: action.incarnation, service: action.service, action: action.action, plan: action.plan, checkedAt: 1000, status: "ready" }) },
  });
  return { ...lab, source, runtime, services, jobs };
};
