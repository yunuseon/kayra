/* eslint-disable functional/no-let -- scheduling belongs to the existing privileged process */
import { reconcileManagedWork } from "../deployment/managed-work.ts";

type Index = Parameters<typeof reconcileManagedWork>[0];
type Ports = Parameters<typeof reconcileManagedWork>[1];
type Report = { readonly status: "ready"; readonly work: Awaited<ReturnType<typeof reconcileManagedWork>> } | { readonly status: "unavailable" };

/** Optional composition hook, not a new process or Docker socket holder. Runtime/input loading happens before each indexed tick. */
export const startManagedController = (index: Index, ports: Ports, report: (value: Report) => void = () => undefined, intervalMs = 1000) => {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 10_000) throw new Error("invalid managed reconciliation interval");
  let stopped = false; let timer: NodeJS.Timeout | undefined;
  const cycle = async () => {
    const result = await reconcileManagedWork(index, ports).then((work) => Object.freeze({ status: "ready" as const, work }), () => Object.freeze({ status: "unavailable" as const })); report(result);
    if (!stopped) { timer = setTimeout(() => { active = cycle(); }, intervalMs); timer.unref(); }
  };
  let active = cycle();
  return Object.freeze({ close: async () => { stopped = true; if (timer !== undefined) clearTimeout(timer); await active; } });
};
