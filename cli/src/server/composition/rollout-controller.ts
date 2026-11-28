/* Owns a scheduling timer in the existing privileged process, not another runtime controller service. */
/* eslint-disable functional/no-let */
import type { openLifecycleAppIndex } from "../deployment/lifecycle-app-index.ts";
import { rolloutExecution } from "../deployment/rollout-execution.ts";
import { reconcileRolloutWork } from "../deployment/rollout-work.ts";

type Index = Parameters<typeof rolloutExecution>[0] & Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "pendingRolloutOperations">>;
type Ports = Parameters<typeof rolloutExecution>[1];
type Report = Readonly<{ status: "ready"; work: Awaited<ReturnType<typeof reconcileRolloutWork>> }> | Readonly<{ status: "unavailable" }>;

export const startRolloutController = (index: Index, ports: Ports, report: (value: Report) => void = () => undefined, intervalMs = 1000) => {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 10_000) throw new Error("invalid rollout reconciliation interval");
  const execution = rolloutExecution(index, ports);
  let stopped = false; let timer: NodeJS.Timeout | undefined;
  const cycle = async () => {
    const result = await reconcileRolloutWork(index, execution).then((work) => Object.freeze({ status: "ready" as const, work }), () => Object.freeze({ status: "unavailable" as const }));
    report(result);
    if (!stopped) { timer = setTimeout(() => { active = cycle(); }, intervalMs); timer.unref(); }
  };
  let active = cycle();
  return Object.freeze({ close: async () => { stopped = true; if (timer !== undefined) clearTimeout(timer); await active; } });
};
