import type { ApplicationPlan } from "../../contracts/http-plan.ts";
import type { HostObserver } from "../../contracts/resource-authority.ts";
import type { RoutedReadinessPort } from "../../contracts/routed-readiness.ts";
import type { SwarmServicePort } from "../../contracts/swarm-service.ts";
import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";

export type HttpExecutionIndex = Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "httpOperation" | "admitHttpRollout" | "recordHttpNativeIntent" | "authorizeHttpNative" | "markHttpDispatched" | "promoteHttpRollout" | "reconcileHttpResources" | "beginHttpRecovery" | "holdHttp" | "recordHttpRecoveryIntent" | "finishHttpUnstarted" | "finishHttpRecovery">>;
export type HttpExecutionPorts = HostObserver & {
  readonly now: () => number;
  readonly read: (digest: string) => Promise<string>;
  readonly materialize: (plan: ApplicationPlan) => Promise<Readonly<Record<string, string>>>;
  readonly routing: (plan: ApplicationPlan) => Readonly<Record<string, string>>;
  readonly native: SwarmServicePort;
  readonly readiness: RoutedReadinessPort;
};

