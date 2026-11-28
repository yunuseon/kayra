import type { RolloutPlanPort } from "../../contracts/rollout-plan.ts";
import type { RolloutRequest } from "./rollout-request.ts";
import { parseMigrationCleanupRequest, parseMigrationCleanupReport } from "../../contracts/migration-cleanup.ts";
import type { HttpPlanPort } from "../../contracts/http-plan.ts";
import type { BuildPorts } from "../../contracts/build-artifact.ts";
import { deploymentRestoreSchema, parseCompleteDeploymentReceipt, parseDeploymentCancellation, parseDeploymentQuery, parseDeploymentReceipt, parseDeploymentRequest } from "../../contracts/deployment-request.ts";
import type { HttpOperation } from "./http-state.ts";
import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";
import { parseMigrationResolutionQuery, parseMigrationResolutionRequest, parseMigrationResolutionReport } from "../../contracts/migration-resolution.ts";
import type { MigrationResolutionActor } from "../../contracts/migration-resolution.ts";
import type { managedOperationControl } from "./managed-operation-control.ts";

type Index = Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "deploymentProtocol" | "prepareRollout" | "httpOperation" | "prepareHttpRollout" | "publishedDeploymentStatus" | "publishedDeploymentRuns" | "publishedDeploymentImagePins" | "publishedDeploymentHealth" | "cancelHttpRollout" | "resolveMigration" | "migrationAudit" | "requestMigrationCleanup" | "migrationCleanupAudit" | "rolloutOperation" | "cancelManagedRollout">>;
type Ports = {
  readonly index: Index;
  readonly canAccess: (app: string) => Promise<boolean>;
  readonly now: () => number;
  readonly enabled: () => Promise<boolean>;
  readonly plans?: (HttpPlanPort & Pick<BuildPorts, "now" | "retain">) | undefined;
  readonly rollouts?: (RolloutPlanPort & Pick<BuildPorts, "now" | "retain">) | undefined;
  readonly observations?: Parameters<Index["publishedDeploymentHealth"]>[1] | undefined;
  readonly managedObservations?: Parameters<Index["publishedDeploymentHealth"]>[2] | undefined;
  readonly artifacts?: Pick<BuildPorts, "read"> | undefined;
  readonly managed?: ReturnType<typeof managedOperationControl> | undefined;
  readonly managedAudit?: ReturnType<typeof managedOperationControl>["audit"] | undefined;
  readonly recovery?: Readonly<{ actor: MigrationResolutionActor; ports: Parameters<Index["resolveMigration"]>[3] }> | undefined;
};

const receipt = (app: string, operation: HttpOperation | undefined) => {
  const parsed = parseDeploymentReceipt(operation === undefined ? null : { version: 1, app, request: operation.request, commit: operation.commit,
    plan: operation.plan, deadline: operation.deadline, phase: operation.phase, cancelRequestedAt: operation.cancelRequestedAt });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

const completeReceipt = (app: string, root: RolloutRequest, http?: HttpOperation | null) => {
  const preparation = root.preparation;
  const parsed = parseCompleteDeploymentReceipt({ version: 2, app, request: preparation.run, commit: root.commit, plan: preparation.plan, deadline: preparation.deadline,
    cancelRequestedAt: http?.cancelRequestedAt ?? preparation.cancelRequestedAt ?? (root.completion?.outcome === "cancelled" ? root.completion.at : null),
    phase: http?.phase ?? root.completion?.outcome ?? (preparation.cancelRequestedAt !== undefined ? preparation.phase === "held" ? "held" : "cancelling" :
      preparation.phase === "ready" ? "ready-for-http" : preparation.phase === "prepared" && root.admitted ? "admitted" : preparation.phase),
  });
  if (!parsed.ok) throw new Error(parsed.error); return parsed.value;
};

/** Local lifecycle interface. Callers cannot supply native authority, private inputs or effect decisions. */
export const deploymentControl = ({ index, canAccess, enabled, plans, rollouts, managed, managedAudit, now, recovery, artifacts, observations, managedObservations }: Ports) => async (path: string, input: unknown) => {
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
    if (await index.deploymentProtocol(query.value.app) === "managed-v3") { const audit = managedAudit ?? managed?.audit; if (audit === undefined) throw new Error("managed migration audit reader unavailable"); return audit(query.value); }
    const parsed = parseMigrationResolutionReport({ version: 1, ...query.value, audit: await index.migrationAudit(query.value.app, query.value.run, query.value.step) ?? null });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  }
  if (path === "/deployment/migration-resolve") {
    const requested = parseMigrationResolutionRequest(input);
    if (!requested.ok) return undefined;
    if (!(await canAccess(requested.value.app))) throw new Error("app is outside deployment scope");
    if (await index.deploymentProtocol(requested.value.app) === "managed-v3") { if (managed === undefined) throw new Error("managed-v3 mutation dispatch is disabled"); return managed.resolve(requested.value); }
    if (recovery === undefined) return undefined;
    return index.resolveMigration(requested.value.app, requested.value, recovery.actor, recovery.ports);
  }
  if (path === "/deployment/health") {
    const query = parseDeploymentQuery(input); if (!query.ok || observations === undefined && managedObservations === undefined) return undefined;
    if (!(await canAccess(query.value.app))) throw new Error("app is outside deployment scope");
    return index.publishedDeploymentHealth(query.value.app, observations, managedObservations);
  }
  if (path === "/deployment/pins") {
    const query = parseDeploymentQuery(input); if (!query.ok || artifacts === undefined) return undefined;
    if (!(await canAccess(query.value.app))) throw new Error("app is outside deployment scope");
    return index.publishedDeploymentImagePins(query.value.app, { read: artifacts.read, now });
  }
  if (path === "/deployment/status") {
    const query = parseDeploymentQuery(input);
    if (!query.ok) return undefined;
    if (!(await canAccess(query.value.app))) throw new Error("app is outside deployment scope");
    return index.publishedDeploymentStatus(query.value.app, artifacts === undefined ? undefined : { read: artifacts.read, now });
  }
  if (path === "/deployment/runs") {
    const query = parseDeploymentQuery(input);
    const detail = parseDeploymentCancellation(input);
    if (!query.ok && !detail.ok || artifacts === undefined) return undefined;
    const app = detail.ok ? detail.value.app : query.ok ? query.value.app : undefined;
    if (app === undefined || !await canAccess(app)) throw new Error("app is outside deployment scope");
    return index.publishedDeploymentRuns(app, detail.ok ? detail.value.request : undefined, { read: artifacts.read, now });
  }
  if (path === "/deployment/restore") {
    const requested = deploymentRestoreSchema.safeParse(input);
    if (!requested.success) return undefined;
    const { app } = requested.data;
    if (managed === undefined || !await enabled() || !await canAccess(app) || await index.deploymentProtocol(app) !== "managed-v3") throw new Error("managed restore is unavailable or outside scope");
    return managed.restore(requested.data);
  }
  if (path === "/deployment/cancel") {
    const requested = parseDeploymentCancellation(input);
    if (!requested.ok) return undefined;
    if (!(await canAccess(requested.value.app))) throw new Error("app is outside deployment scope");
    if (await index.deploymentProtocol(requested.value.app) === "managed-v3") { if (managed === undefined) throw new Error("managed-v3 mutation dispatch is disabled"); return managed.cancel(requested.value); }
    if (await index.rolloutOperation(requested.value.app, requested.value.request) !== undefined) {
      const answer = await index.cancelManagedRollout(requested.value.app, requested.value.request, { now });
      return completeReceipt(requested.value.app, answer.operation, answer.http);
    }
    return receipt(requested.value.app, await index.cancelHttpRollout(requested.value.app, requested.value.request, now()));
  }
  if (path !== "/deployment/prepare") return undefined;
  const requested = parseDeploymentRequest(input);
  if (!requested.ok || plans === undefined && rollouts === undefined && managed === undefined) return undefined;
  if (!(await enabled()) || !(await canAccess(requested.value.app))) throw new Error("experimental deployment is unavailable or outside scope");
  const { app, request, commit } = requested.value;
  if (await index.deploymentProtocol(app) === "managed-v3") { if (managed === undefined) throw new Error("managed-v3 mutation dispatch is disabled"); return managed.prepare(requested.value); }
  if (rollouts !== undefined) {
    const root = await index.rolloutOperation(app, request); const http = await index.httpOperation(app, request);
    if (root === undefined && http !== undefined) {
      if (http.commit !== commit) throw new Error("deployment request identity has conflicting commit"); return receipt(app, http);
    }
    const operation = await index.prepareRollout(app, request, commit, rollouts);
    return completeReceipt(app, operation, http);
  }
  if (plans === undefined) throw new Error("deployment plan port is unavailable");
  const operation = await index.prepareHttpRollout(app, request, commit, plans);
  return receipt(app, operation);
};
