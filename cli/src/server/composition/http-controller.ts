/* Owns a timer and one live scheduling round in the existing deployer process. */
/* eslint-disable functional/no-let */
import type { openLifecycleAppIndex } from "../deployment/lifecycle-app-index.ts";
import type { HttpExecutionIndex, HttpExecutionPorts } from "../deployment/http-execution-ports.ts";
import { httpExecution } from "../deployment/http-execution.ts";
import { reconcileHttpWork } from "../deployment/http-work.ts";

type Index = HttpExecutionIndex & Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "pendingHttpOperations">>;
type Report = Readonly<{ status: "ready"; work: Awaited<ReturnType<typeof reconcileHttpWork>> }> | Readonly<{ status: "unavailable" }>;

export const startHttpController = (index: Index, ports: HttpExecutionPorts, report: (value: Report) => void = () => undefined, intervalMs = 1000) => {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 10_000) throw new Error("invalid HTTP reconciliation interval");
  const execution = httpExecution(index, ports);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const cycle = async () => {
    const result = await reconcileHttpWork(index, execution).then((work) => Object.freeze({ status: "ready" as const, work }), () => Object.freeze({ status: "unavailable" as const }));
    report(result);
    if (!stopped) {
      timer = setTimeout(() => { active = cycle(); }, intervalMs);
      timer.unref();
    }
  };
  let active = cycle();
  return Object.freeze({ close: async () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    await active;
  } });
};
