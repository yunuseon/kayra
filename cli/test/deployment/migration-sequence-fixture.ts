/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types -- owns fake runtime, clocks and test journal handles */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { JobPlan, JobPort } from "../../src/contracts/one-shot-job.ts";
import { jobName } from "../../src/contracts/one-shot-job.ts";
import type { MigrationSequencePlan } from "../../src/contracts/migration-sequence.ts";
import { openArtifactStore } from "../../src/server/deployment/artifact-store.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { migrationSequence } from "../../src/server/deployment/migration-sequence.ts";
import type { MigrationSequenceState } from "../../src/server/deployment/migration-sequence.ts";
import type { JobExecution } from "../../src/server/deployment/one-shot-execution.ts";
import { jobPlan, jobRuntime } from "./one-shot-fixture.ts";
import { typed } from "../../src/lib/typed.ts";

export const sequencePlan = () => {
  const job = jobPlan();
  return typed<MigrationSequencePlan>({ version: 1, deployment: "d".repeat(64), scope: { app: job.scope.app, incarnation: job.scope.incarnation, run: job.scope.run },
    policy: { schedulingSeconds: 90, cleanupSeconds: 30, maximumAttempts: 8, timeoutCeilingSeconds: 90 },
    steps: ["schema", "seed"].map((id) => ({ definition: { id, service: "web", command: ["node", "migrate.mjs", id], timeout_seconds: 30, recovery: { kind: "replay-safe" } },
      template: { version: 1, image: job.image, entrypoint: job.entrypoint, environment: job.environment, resources: job.resources, networks: job.networks, stopGraceSeconds: job.stopGraceSeconds } })),
  });
};
type Options = { readonly afterStart?: (plan: JobPlan, runtime: ReturnType<typeof jobRuntime>) => void;
  readonly probe?: "applied" | "not-applied" | "unknown"; readonly admitted?: boolean;
  readonly beforeEffect?: (effect: "create" | "start" | "fence", job: JobExecution) => void };

export const sequenceFixture = async (t: TestContext, plan = sequencePlan(), options: Options = {}) => {
  const path = await mkdtemp(join(tmpdir(), "kayra-sequence-test-")); const artifacts = await openArtifactStore(join(path, "artifacts"));
  let journal = await openJournal(path); let clock = 1000;
  const nodes = new Map<string, ReturnType<typeof jobRuntime>>();
  const runtime = (job: JobPlan) => {
    const name = jobName(job.scope); let node = nodes.get(name);
    if (node === undefined) { node = jobRuntime(job); nodes.set(name, node); } node.now(clock); return node;
  };
  const native: JobPort = {
    observe: async (job) => {
      const value = await runtime(job).native.observe(job);
      return value.status === "owned" && job.scope.purpose === "probe" && value.state === "succeeded" ? { ...value, probe: options.probe ?? "unknown" } : value;
    },
    create: (job, environment) => runtime(job).native.create(job, environment),
    start: async (job, id, deadline) => { const node = runtime(job); const result = await node.native.start(job, id, deadline); if (result === "acknowledged") options.afterStart?.(job, node); return result; },
    fence: (job, id, deadline) => runtime(job).native.fence(job, id, deadline),
  };
  const ports: Parameters<typeof migrationSequence>[1] = { ...artifacts, native, now: () => clock,
    authorize: (_state, _plan, job, effect) => { options.beforeEffect?.(effect, job); return Promise.resolve(options.admitted ?? true); },
    materialize: () => Promise.resolve({ TOKEN: "secret-value" }) };
  let owner = migrationSequence(journal, ports);
  t.after(async () => { await journal.close(); await rm(path, { recursive: true, force: true }); });
  const drive = async (predicate: (state: MigrationSequenceState) => boolean = (state) => state.phase !== "running") => {
    for (let number = 0; number < 200; number++) { const value = await owner.tick(); if (predicate(value)) return value; }
    throw new Error("sequence did not reach expected state");
  };
  return { plan, path, artifacts, nodes, ports, runtime, owner: () => owner, drive, journal: () => journal,
    prepare: (deadline = 200_000) => owner.prepare(plan, deadline), now: (next: number) => { clock = next; },
    reopen: async (changed: Partial<Parameters<typeof migrationSequence>[1]> = {}) => { await journal.close(); journal = await openJournal(path, "existing"); owner = migrationSequence(journal, { ...ports, ...changed }); return owner; },
  };
};
