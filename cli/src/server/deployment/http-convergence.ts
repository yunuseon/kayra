import type { HttpNativeStep } from "./http-state.ts";
import type { RoutedReadiness } from "../../contracts/routed-readiness.ts";
import type { ServiceAction, ServiceObservation } from "../../contracts/swarm-service.ts";

const terminal = new Set(["shutdown", "complete", "failed", "rejected", "remove", "orphaned"]);

/** Historical failed tasks are evidence, not current failure; draining tasks still prevent settlement. */
export const convergedHttp = (expected: ServiceAction, observed: ServiceObservation) => {
  if (observed.status !== "owned" || observed.specMatches !== true || observed.tombstone || observed.replicas !== 1 || observed.endpoint !== "vip" ||
    observed.taskPlan !== expected.plan || observed.taskEffect !== expected.effect || ![null, "completed", "rollback_completed"].includes(observed.update)) return false;
  const current = observed.tasks.filter((task) => !terminal.has(task.state));
  const task = current[0];
  return current.length === 1 && task?.desired === "running" && task.state === "running" && task.health === "healthy" &&
    task.incarnation === expected.incarnation && task.plan === expected.plan && task.action === expected.action && task.effect === expected.effect;
};

export const routedHttp = (expected: ServiceAction, observed: RoutedReadiness, now: number) =>
  Number.isSafeInteger(now) && now > 0 && Number.isSafeInteger(observed.checkedAt) && observed.checkedAt > 0 && observed.checkedAt <= now && now - observed.checkedAt <= 2000 && observed.status === "ready" &&
  observed.app === expected.app && observed.service === expected.service && observed.incarnation === expected.incarnation && observed.action === expected.action && observed.plan === expected.plan;


/** Every recorded update revision must be unable to arrive after settlement. Names stay reserved. */
export const fencedHttpEffects = (steps: readonly HttpNativeStep[], observed: ServiceObservation) =>
  observed.status === "owned" && steps.every((step) => step.expected === null || (step.expected.id === observed.id && step.expected.version < observed.version));

export const clearedHttp = (observed: ServiceObservation) => observed.status === "owned" && observed.tombstone && observed.retainedInputsCleared &&
  observed.replicas === 0 && observed.endpoint === "dnsrr" && observed.tasks.every((task) => terminal.has(task.state));
