import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";
import type { IndexedManagedRuntime } from "./indexed-managed-lifecycle.ts";
import type { ManagedDeploymentReadPort } from "../../contracts/managed-deployment-read.ts";
import type { ManagedExecutionContext } from "../../contracts/managed-execution-context.ts";

type Index = Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "pendingManagedDeployments" | "managedExecutionContext" | "tickManagedDeployment">>;
export type ManagedWorkPorts = ManagedDeploymentReadPort & {
  /** Called before entering the app writer. Bind immutable job inputs and current platform capabilities here, never recursively from a runtime effect. */
  readonly forRun: (context: ManagedExecutionContext) => Promise<IndexedManagedRuntime | undefined>;
};
/** Reconciliation never rebuilds a branch or invents another execution window. One unavailable application must not starve the others. */
export const reconcileManagedWork = async (index: Index, ports: ManagedWorkPorts) => {
  const loadRuntime = async (context: ManagedExecutionContext) => {
    const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, 10_000);
    try { return await Promise.race([Promise.resolve().then(() => ports.forRun(context)).catch(() => undefined), timeout.promise]); } finally { clearTimeout(timer); }
  };
  const pending = await index.pendingManagedDeployments(ports.now());
  return Object.freeze(await Promise.all(pending.map(async (item) => {
    try {
      const context = await index.managedExecutionContext(item.app, item.run, ports); if (context === undefined) return Object.freeze({ ...item, outcome: "settled" as const });
      const runtime = await loadRuntime(context); if (runtime === undefined) return Object.freeze({ ...item, outcome: "unavailable" as const });
      const state = await index.tickManagedDeployment(item.app, item.run, runtime); return Object.freeze({ ...item, outcome: state?.operation.phase ?? "unavailable" });
    } catch { return Object.freeze({ ...item, outcome: "unavailable" as const }); }
  })));
};
