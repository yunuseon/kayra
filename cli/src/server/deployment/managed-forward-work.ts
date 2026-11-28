import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";
import type { ManagedForwardCleanupContext, ManagedForwardCleanupRuntimePort } from "../../contracts/managed-forward-cleanup-context.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";

type Index = Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "pendingManagedForwardRequests" |
  "prepareManagedForwardCleanup" | "managedForwardCleanupContext" | "tickManagedForwardCleanup" |
  "prepareManagedForwardHandoff" | "transferManagedForwardAdmission" | "installManagedForwardRoot" | "activateManagedForward">>;
type Ports = Parameters<Index["transferManagedForwardAdmission"]>[2] & {
  readonly runtime: (context: ManagedForwardCleanupContext) => ManagedForwardCleanupRuntimePort;
  readonly retained: (context: ManagedForwardCleanupContext) => ManagedWorkloadPort["observeDesired"];
};

/** Work comes from published forward reservations. Restart follows the durable stage and reconciles each effect through the index. */
export const reconcileManagedForwardWork = async (index: Index, ports: Ports) => {
  const pending = await index.pendingManagedForwardRequests(ports);
  return Object.freeze(await Promise.all(pending.map(async (request) => {
    const app = request.app;
    const report = (outcome: "fencing" | "held" | "activated" | "unavailable") => Object.freeze({ app, run: request.request, outcome });
    try {
      const prepared = await index.prepareManagedForwardCleanup(app, request, ports);
      if (prepared.state === null || prepared.state.phase === "held") return report("held");
      if (prepared.state.phase !== "complete") {
        const effect = await index.tickManagedForwardCleanup(app, request, ports, ports.runtime);
        return report(effect.phase === "held" ? "held" : "fencing");
      }
      const context = await index.managedForwardCleanupContext(app, request, ports);
      const retained = ports.retained(context);
      // Each command verifies its persisted predecessor or exact durable receipt before progressing.
      await index.prepareManagedForwardHandoff(app, request, ports, ports.runtime, retained);
      await index.transferManagedForwardAdmission(app, request, ports, ports.runtime, retained);
      await index.installManagedForwardRoot(app, request, ports, ports.runtime, retained);
      await index.activateManagedForward(app, request, ports, ports.runtime, retained);
      return report("activated");
    } catch {
      return report("unavailable");
    }
  })));
};
