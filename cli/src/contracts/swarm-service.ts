import type { ApplicationPlan } from "./http-plan.ts";

/** Native object authority. The coordinator persists an intent before calling a writer. */
export type ServiceScope = { readonly app: string; readonly service: string; readonly incarnation: string };
export type ServiceAction = ServiceScope & { readonly action: string; readonly plan: string; readonly deadline: number };
export type ServiceVersion = { readonly id: string; readonly version: number };
export type ServiceWrite = "acknowledged" | "uncertain" | "conflict" | "refused";
export type ServiceObservation =
  | { readonly status: "absent" | "foreign" | "unavailable" }
  | { readonly status: "owned"; readonly id: string; readonly version: number; readonly action: string | null;
      readonly plan: string | null; readonly taskPlan: string | null; readonly tombstone: boolean; readonly retainedInputsCleared: boolean; readonly specMatches: boolean | null;
      readonly replicas: number; readonly endpoint: "vip" | "dnsrr"; readonly update: string | null;
      readonly tasks: readonly { readonly id: string; readonly incarnation: string; readonly plan: string | null; readonly action: string | null;
        readonly desired: string; readonly state: string; readonly health: "healthy" | "unhealthy" | "starting" | "absent" | "unknown" }[] };

export type SwarmServicePort = {
  readonly observe: (scope: ServiceScope) => Promise<ServiceObservation>;
  readonly observeDesired: (action: ServiceAction, plan: ApplicationPlan, environment: Readonly<Record<string, string>>, routing: Readonly<Record<string, string>>) => Promise<ServiceObservation>;
  readonly apply: (action: ServiceAction, expected: ServiceVersion | null, plan: ApplicationPlan,
    environment: Readonly<Record<string, string>>, routing: Readonly<Record<string, string>>) => Promise<ServiceWrite>;
  readonly fence: (action: ServiceAction, expected: ServiceVersion) => Promise<ServiceWrite>;
  readonly tombstone: (action: ServiceAction, expected: ServiceVersion, image: string) => Promise<ServiceWrite>;
};
