import type { HttpNativeStep } from "./http-state.ts";
import type { RoutedReadiness } from "../../contracts/routed-readiness.ts";
import type { ServiceAction, ServiceObservation } from "../../contracts/swarm-service.ts";

export { convergedService as convergedHttp, clearedService as clearedHttp } from "./service-convergence.ts";

export const routedHttp = (expected: ServiceAction, observed: RoutedReadiness, now: number) =>
  Number.isSafeInteger(now) && now > 0 && Number.isSafeInteger(observed.checkedAt) && observed.checkedAt > 0 && observed.checkedAt <= now && now - observed.checkedAt <= 2000 && observed.status === "ready" &&
  observed.app === expected.app && observed.service === expected.service && observed.incarnation === expected.incarnation && observed.action === expected.action && observed.plan === expected.plan;


/** Every recorded update revision must be unable to arrive after settlement. Names stay reserved. */
export const fencedHttpEffects = (steps: readonly HttpNativeStep[], observed: ServiceObservation) =>
  observed.status === "owned" && steps.every((step) => step.expected === null || (step.expected.id === observed.id && step.expected.version < observed.version));
