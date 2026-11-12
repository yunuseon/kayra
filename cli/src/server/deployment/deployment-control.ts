import type { HttpPlanPort } from "../../contracts/http-plan.ts";
import type { BuildPorts } from "../../contracts/build-artifact.ts";
import { parseDeploymentQuery, parseDeploymentReceipt, parseDeploymentRequest } from "../../contracts/deployment-request.ts";
import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";

type Index = Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "prepareHttpRollout" | "deploymentStatus">>;
type Ports = {
  readonly index: Index;
  readonly canAccess: (app: string) => Promise<boolean>;
  readonly enabled: () => Promise<boolean>;
  readonly plans?: (HttpPlanPort & Pick<BuildPorts, "now" | "retain">) | undefined;
};

/** Local lifecycle interface. Callers cannot supply native authority, private inputs or effect decisions. */
export const deploymentControl = ({ index, canAccess, enabled, plans }: Ports) => async (path: string, input: unknown) => {
  if (path === "/deployment/status") {
    const query = parseDeploymentQuery(input);
    if (!query.ok) return undefined;
    if (!(await canAccess(query.value.app))) throw new Error("app is outside deployment scope");
    return index.deploymentStatus(query.value.app);
  }
  if (path !== "/deployment/prepare") return undefined;
  const requested = parseDeploymentRequest(input);
  if (!requested.ok || plans === undefined) return undefined;
  if (!(await enabled()) || !(await canAccess(requested.value.app))) throw new Error("experimental deployment is unavailable or outside scope");
  const operation = await index.prepareHttpRollout(requested.value.app, requested.value.request, requested.value.commit, plans);
  const parsed = parseDeploymentReceipt({ version: 1, app: requested.value.app, request: operation.request, commit: operation.commit,
    plan: operation.plan, deadline: operation.deadline, phase: operation.phase });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
