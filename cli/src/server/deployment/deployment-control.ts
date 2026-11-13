import { parseMigrationCleanupRequest, parseMigrationCleanupReport } from "../../contracts/migration-cleanup.ts";
import type { HttpPlanPort } from "../../contracts/http-plan.ts";
import type { BuildPorts } from "../../contracts/build-artifact.ts";
import { parseDeploymentCancellation, parseDeploymentQuery, parseDeploymentReceipt, parseDeploymentRequest } from "../../contracts/deployment-request.ts";
import type { HttpOperation } from "./http-state.ts";
import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";
import { parseMigrationResolutionQuery, parseMigrationResolutionRequest, parseMigrationResolutionReport } from "../../contracts/migration-resolution.ts";
import type { MigrationResolutionActor } from "../../contracts/migration-resolution.ts";

type Index = Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "prepareHttpRollout" | "deploymentStatus" | "cancelHttpRollout" | "resolveMigration" | "migrationAudit" | "requestMigrationCleanup" | "migrationCleanupAudit">>;
type Ports = {
  readonly index: Index;
  readonly canAccess: (app: string) => Promise<boolean>;
  readonly now: () => number;
  readonly enabled: () => Promise<boolean>;
  readonly plans?: (HttpPlanPort & Pick<BuildPorts, "now" | "retain">) | undefined;
  readonly recovery?: Readonly<{ actor: MigrationResolutionActor; ports: Parameters<Index["resolveMigration"]>[3] }> | undefined;
};

const receipt = (app: string, operation: HttpOperation | undefined) => {
  const parsed = parseDeploymentReceipt(operation === undefined ? null : { version: 1, app, request: operation.request, commit: operation.commit,
    plan: operation.plan, deadline: operation.deadline, phase: operation.phase, cancelRequestedAt: operation.cancelRequestedAt });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

/** Local lifecycle interface. Callers cannot supply native authority, private inputs or effect decisions. */
export const deploymentControl = ({ index, canAccess, enabled, plans, now, recovery }: Ports) => async (path: string, input: unknown) => {
  if (path === "/deployment/migration-cleanup-audit") {
    const query = parseMigrationResolutionQuery(input); if (!query.ok) return undefined;
    if (!(await canAccess(query.value.app))) throw new Error("app is outside deployment scope");
    return parseMigrationCleanupReport({ version: 1, ...query.value, cleanups: await index.migrationCleanupAudit(query.value.app, query.value.run, query.value.step) });
  }
  if (path === "/deployment/migration-cleanup") {
    const requested = parseMigrationCleanupRequest(input); if (!requested.ok || recovery === undefined) return undefined;
    if (!(await canAccess(requested.value.app))) throw new Error("app is outside deployment scope");
    return index.requestMigrationCleanup(requested.value.app, requested.value, recovery.actor, recovery.ports);
  }
  if (path === "/deployment/migration-audit") {
    const query = parseMigrationResolutionQuery(input);
    if (!query.ok) return undefined;
    if (!(await canAccess(query.value.app))) throw new Error("app is outside deployment scope");
    const parsed = parseMigrationResolutionReport({ version: 1, ...query.value, audit: await index.migrationAudit(query.value.app, query.value.run, query.value.step) ?? null });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  }
  if (path === "/deployment/migration-resolve") {
    const requested = parseMigrationResolutionRequest(input);
    if (!requested.ok || recovery === undefined) return undefined;
    if (!(await canAccess(requested.value.app))) throw new Error("app is outside deployment scope");
    return index.resolveMigration(requested.value.app, requested.value, recovery.actor, recovery.ports);
  }
  if (path === "/deployment/status") {
    const query = parseDeploymentQuery(input);
    if (!query.ok) return undefined;
    if (!(await canAccess(query.value.app))) throw new Error("app is outside deployment scope");
    return index.deploymentStatus(query.value.app);
  }
  if (path === "/deployment/cancel") {
    const requested = parseDeploymentCancellation(input);
    if (!requested.ok) return undefined;
    if (!(await canAccess(requested.value.app))) throw new Error("app is outside deployment scope");
    return receipt(requested.value.app, await index.cancelHttpRollout(requested.value.app, requested.value.request, now()));
  }
  if (path !== "/deployment/prepare") return undefined;
  const requested = parseDeploymentRequest(input);
  if (!requested.ok || plans === undefined) return undefined;
  if (!(await enabled()) || !(await canAccess(requested.value.app))) throw new Error("experimental deployment is unavailable or outside scope");
  const operation = await index.prepareHttpRollout(requested.value.app, requested.value.request, requested.value.commit, plans);
  return receipt(requested.value.app, operation);
};
