import type { ManagedServicePlan } from "./managed-service-plan.ts";
import type { VolumeReceipt } from "./owned-volume.ts";
import type { ServiceAction, ServiceScope, ServiceVersion, ServiceWrite, ServiceObservation } from "./swarm-service.ts";

export type ManagedServiceScope = ServiceScope & { readonly dataOwner: string };
export type ManagedServiceAction = ServiceAction & ManagedServiceScope;
/** Ephemeral adapter inputs. Resolved environment values must never enter operation journals or read models. */
export type ManagedServiceInputs = {
  readonly environment: Readonly<Record<string, string>>;
  readonly routing: Readonly<Record<string, string>>;
  readonly volumes: readonly VolumeReceipt[];
};
export type ManagedSwarmServicePort = {
  readonly observe: (scope: ManagedServiceScope) => Promise<ServiceObservation>;
  readonly observeDesired: (action: ManagedServiceAction, plan: ManagedServicePlan, inputs: ManagedServiceInputs) => Promise<ServiceObservation>;
  readonly apply: (action: ManagedServiceAction, expected: ServiceVersion | null, plan: ManagedServicePlan, inputs: ManagedServiceInputs) => Promise<ServiceWrite>;
  readonly fence: (action: ManagedServiceAction, expected: ServiceVersion) => Promise<ServiceWrite>;
  readonly tombstone: (action: ManagedServiceAction, expected: ServiceVersion | null, image: string) => Promise<ServiceWrite>;
};
