import type { ApplicationPlan } from "./http-plan.ts";
import type { ServiceAction } from "./swarm-service.ts";

export type RoutedReadiness = {
  readonly app: string; readonly service: string; readonly incarnation: string;
  readonly action: string; readonly plan: string; readonly checkedAt: number;
  readonly status: "ready" | "unready" | "unavailable";
};
export type RoutedReadinessPort = {
  readonly check: (action: ServiceAction, plan: ApplicationPlan) => Promise<RoutedReadiness>;
};
