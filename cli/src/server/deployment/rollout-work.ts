import type { rolloutExecution } from "./rollout-execution.ts";
import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";

type Index = Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "pendingRolloutOperations">>;
type Execution = Readonly<Pick<ReturnType<typeof rolloutExecution>, "tick">>;

/** Scheduling belongs to the composition root; a failing app must not starve another app. */
export const reconcileRolloutWork = async (index: Index, execution: Execution) => {
  const work = await index.pendingRolloutOperations();
  return Object.freeze(await Promise.all(work.map(async (item) => {
    try { return Object.freeze({ ...item, outcome: await execution.tick(item.app, item.request) }); }
    catch { return Object.freeze({ ...item, outcome: "unavailable" }); }
  })));
};
