import type { JobCleanupPort } from "../../contracts/job-cleanup.ts";
import type { JobPort } from "../../contracts/one-shot-job.ts";
import type { HttpExecutionPorts, HttpExecutionIndex } from "./http-execution-ports.ts";
import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";
import { httpExecution } from "./http-execution.ts";

type Index = HttpExecutionIndex & Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "rolloutOperation" | "admitRollout" | "tickRolloutPreparation" | "handoffRollout" | "expireRolloutAdmission" | "reconcileRolloutResources" | "tickMigrationCleanup" | "completeCancelledPreparation">>;
type Ports = HttpExecutionPorts & { readonly jobs: JobPort; readonly retain: (bytes: string) => Promise<string>; readonly cleanup?: JobCleanupPort | undefined };

/** The composition root installs one application owner; phase adapters never create competing controllers. */
export const rolloutExecution = (index: Index, ports: Ports) => {
  const http = httpExecution(index, ports);
  const running = new Map<string, { readonly request: string; readonly result: Promise<string> }>();
  const execute = async (app: string, request: string) => {
    const operation = await index.rolloutOperation(app, request); if (operation === undefined) throw new Error("complete rollout operation is unavailable");
    if (operation.completion !== undefined) { await index.reconcileRolloutResources(app, operation.ticket); return operation.completion.outcome; }
    const workload = await index.httpOperation(app, request);
    if (workload !== undefined) return http.tick(app, request);
    if (operation.preparation.cancelRequestedAt !== undefined) {
      const completed = await index.completeCancelledPreparation(app, request, ports.now());
      if (completed.completion !== undefined) return completed.completion.outcome;
    }
    if (!operation.admitted) {
      if (ports.now() >= operation.admissionDeadline && await index.expireRolloutAdmission(app, request, ports.now()) === "failed") return "failed";
      await index.admitRollout(app, operation.ticket, ports); return "admitted";
    }
    if (operation.preparation.phase === "held") {
      for (const step of operation.preparation.sequence?.steps ?? []) for (const attempt of step.attempts) {
        const record = attempt.cleanups?.at(-1); if (record?.state.phase !== "fencing") continue;
        if (ports.cleanup === undefined) throw new Error("migration cleanup runtime port is unavailable");
        const result = await index.tickMigrationCleanup(app, { app, run: request, step: step.id, purpose: attempt.purpose, attempt: attempt.attempt, action: record.state.authority.action },
          { read: ports.read, now: ports.now, native: ports.cleanup });
        return result.phase === "fencing" ? "cleaning-up" : result.phase === "complete" ? (await index.rolloutOperation(app, request))?.preparation.phase ?? "held" : "held";
      }
      return "held";
    }
    if (operation.preparation.phase !== "ready") {
      const state = await index.tickRolloutPreparation(app, request, { ...ports, native: ports.jobs,
        materialize: (_job, plan) => ports.materialize(plan.workload) });
      return state.phase;
    }
    await index.handoffRollout(app, request, ports); return "handoff";
  };
  // Recursive: queued requests call tick again after the current app operation settles.
  const tick = (app: string, request: string): Promise<string> => {
    const existing = running.get(app);
    if (existing !== undefined) return existing.request === request ? existing.result : existing.result.then(() => tick(app, request), () => tick(app, request));
    const result = execute(app, request);
    // eslint-disable-next-line functional/immutable-data -- owns live application reconciliation promises
    running.set(app, Object.freeze({ request, result }));
    const release = () => {
      // eslint-disable-next-line functional/immutable-data -- releases the settled reconciliation promise
      running.delete(app);
    };
    void result.then(release, release); return result;
  };
  return Object.freeze({ tick });
};
