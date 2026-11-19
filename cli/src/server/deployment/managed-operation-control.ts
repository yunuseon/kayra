import { parseDeploymentCancellation, parseDeploymentRequest } from "../../contracts/deployment-request.ts";
import type { ManagedExecutionContext } from "../../contracts/managed-execution-context.ts";
import type { ManagedDeploymentReadPort } from "../../contracts/managed-deployment-read.ts";
import type { IndexedManagedRuntime } from "./indexed-managed-lifecycle.ts";
import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";
import type { managedPreparation } from "./managed-preparation.ts";
import { managedSourceContext } from "./managed-source-context.ts";
import { managedReceipt } from "./managed-receipt.ts";

type Index = Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "acceptedManagedRequest" | "retainedManagedBuild" | "cancelManagedDeployment">>;
type Ports = ManagedDeploymentReadPort & { readonly canAccess: (app: string) => Promise<boolean>; readonly prepare: ReturnType<typeof managedPreparation>["prepare"]; readonly forRun: (context: ManagedExecutionContext) => Promise<IndexedManagedRuntime | undefined> };

/** Owner commands publish validated receipts; clients cannot provide plans, runtime ports, grants or recovery evidence. The transport authenticates app scope independently. */
export const managedOperationControl = (index: Index, ports: Ports) => {
  const retained = async (app: string, run: string) => { const value = await index.acceptedManagedRequest(app, run, ports); if (value === undefined) throw new Error("managed operation is unavailable"); return value; };
  const runtime = async (context: ManagedExecutionContext) => {
    const expired = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { expired.resolve(undefined); }, 10_000);
    try { return await Promise.race([Promise.resolve().then(() => ports.forRun(context)).catch(() => undefined), expired.promise]); } finally { clearTimeout(timer); }
  };
  return Object.freeze({
    prepare: async (input: unknown) => {
      const checked = parseDeploymentRequest(input); if (!checked.ok) throw new Error(checked.error); const { app, request, commit } = checked.value;
      if (!await ports.canAccess(app)) throw new Error("app is outside managed operation scope");
      const existing = await index.acceptedManagedRequest(app, request, ports);
      if (existing === undefined) await index.retainedManagedBuild(app, commit, ports);
      else if (existing.source.candidate.commit !== commit) throw new Error("managed operation commit disagrees");
      await ports.prepare(app, request, commit); const value = await retained(app, request); if (value.source.candidate.commit !== commit) throw new Error("managed operation commit disagrees");
      return managedReceipt(value.source, value.request);
    },
    cancel: async (input: unknown) => {
      const checked = parseDeploymentCancellation(input); if (!checked.ok) throw new Error(checked.error); const { app, request } = checked.value;
      if (!await ports.canAccess(app)) throw new Error("app is outside managed operation scope"); const before = await retained(app, request);
      if (before.request.completion === null) { const loaded = await runtime(managedSourceContext(before.source)); if (loaded === undefined) throw new Error("managed cancellation runtime unavailable"); await index.cancelManagedDeployment(app, request, loaded); }
      const value = await retained(app, request); return managedReceipt(value.source, value.request);
    },
  });
};
