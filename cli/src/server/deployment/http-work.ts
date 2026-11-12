import type { httpExecution } from "./http-execution.ts";
import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";

type Index = Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "pendingHttpOperations">>;
type Execution = Readonly<Pick<ReturnType<typeof httpExecution>, "tick">>;

/** One restart/scheduling round; the composition root owns when rounds run. */
export const reconcileHttpWork = async (index: Index, execution: Execution) => {
  const work = await index.pendingHttpOperations();
  const results = await Promise.all(work.map(async (item) => {
    try { return Object.freeze({ ...item, outcome: await execution.tick(item.app, item.request) }); }
    // Port failures may contain private runtime or configuration data. Publish only identity.
    catch { return Object.freeze({ ...item, outcome: "unavailable" }); }
  }));
  return Object.freeze(results);
};
