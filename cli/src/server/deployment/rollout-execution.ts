import type { JobPort } from "../../contracts/one-shot-job.ts";
import type { HttpExecutionPorts, HttpExecutionIndex } from "./http-execution-ports.ts";
import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";
import { httpExecution } from "./http-execution.ts";

type Index = HttpExecutionIndex & Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "rolloutOperation" | "admitRollout" | "tickRolloutPreparation" | "handoffRollout">>;
type Ports = HttpExecutionPorts & { readonly jobs: JobPort; readonly retain: (bytes: string) => Promise<string> };

/** The composition root installs one application owner; phase adapters never create competing controllers. */
export const rolloutExecution = (index: Index, ports: Ports) => {
  const http = httpExecution(index, ports);
  const running = new Map<string, { readonly request: string; readonly result: Promise<string> }>();
  const execute = async (app: string, request: string) => {
    const operation = await index.rolloutOperation(app, request); if (operation === undefined) throw new Error("complete rollout operation is unavailable");
    const workload = await index.httpOperation(app, request);
    if (workload !== undefined) return http.tick(app, request);
    if (!operation.admitted) { await index.admitRollout(app, operation.ticket, ports); return "admitted"; }
    if (operation.preparation.phase === "held") return "held";
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
