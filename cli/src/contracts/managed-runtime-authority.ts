import type { ManagedExecutionContext } from "./managed-execution-context.ts";
import type { ManagedApplicationPlan } from "./managed-application-plan.ts";
import type { ManagedServicePlan } from "./managed-service-plan.ts";
import type { ManagedServiceAction } from "./managed-swarm-service.ts";
import type { MigrationResolutionActor, MigrationResolutionRequest } from "./migration-resolution.ts";
import type { JobPlan } from "./one-shot-job.ts";

/** Current platform grants, not coordinator admission or a durable effect intent. No private deployment journal types cross this boundary. */
export type ManagedRuntimePermission =
  | { readonly kind: "admission" | "allocation" | "verify" | "recovery" | "accepted-recovery" }
  | { readonly kind: "service"; readonly purpose: "deployment" | "cleanup"; readonly action: ManagedServiceAction }
  | { readonly kind: "service-inputs"; readonly application: ManagedApplicationPlan; readonly service: ManagedServicePlan }
  | { readonly kind: "migration"; readonly effect: "create" | "start" | "fence" }
  | { readonly kind: "check"; readonly check: string; readonly effect: "create" | "start" }
  | { readonly kind: "migration-resolution"; readonly request: MigrationResolutionRequest; readonly actor: MigrationResolutionActor }
  | { readonly kind: "job"; readonly job: JobPlan; readonly effect: "observe" | "create" | "start" | "fence" };
export type ManagedRuntimeAuthorityPort = { readonly allowed: (context: ManagedExecutionContext, permission: ManagedRuntimePermission) => Promise<boolean> };
