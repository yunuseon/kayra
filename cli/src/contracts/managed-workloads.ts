import type { ManagedApplicationPlan } from "./managed-application-plan.ts";
import type { ManagedServicePlan } from "./managed-service-plan.ts";
import type { ManagedServiceAction, ManagedServiceScope } from "./managed-swarm-service.ts";
import type { ServiceObservation, ServiceVersion, ServiceWrite } from "./swarm-service.ts";

/** Coordinator-facing composition port. Context pins routing/grants; the adapter still receives only its service spec and ephemeral inputs. */
export type ManagedWorkloadPort = {
  readonly observe: (scope: ManagedServiceScope) => Promise<ServiceObservation>;
  readonly observeDesired: (action: ManagedServiceAction, service: ManagedServicePlan, context: ManagedApplicationPlan) => Promise<ServiceObservation>;
  readonly apply: (action: ManagedServiceAction, expected: ServiceVersion | null, service: ManagedServicePlan, context: ManagedApplicationPlan) => Promise<ServiceWrite>;
  /** Metadata-only CAS fence preserves the current task template. */
  readonly fence?: (action: ManagedServiceAction, expected: ServiceVersion) => Promise<ServiceWrite>;
  readonly tombstone: (action: ManagedServiceAction, expected: ServiceVersion | null, image: string) => Promise<ServiceWrite>;
};
