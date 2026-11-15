import type { ServiceAction, ServiceObservation } from "../../contracts/swarm-service.ts";

const terminal = new Set(["shutdown", "complete", "failed", "rejected", "remove", "orphaned"]);

/** Historical failed tasks are evidence, not current failure; draining tasks still prevent settlement. */
export const convergedService = (expected: ServiceAction, observed: ServiceObservation) => {
  if (observed.status !== "owned" || observed.specMatches !== true || observed.tombstone || observed.replicas !== 1 || observed.endpoint !== "vip" ||
    observed.taskPlan !== expected.plan || observed.taskEffect !== expected.effect || ![null, "completed", "rollback_completed"].includes(observed.update)) return false;
  const current = observed.tasks.filter((task) => !terminal.has(task.state));
  const task = current[0];
  return current.length === 1 && task?.desired === "running" && task.state === "running" && task.health === "healthy" &&
    task.incarnation === expected.incarnation && task.plan === expected.plan && task.action === expected.action && task.effect === expected.effect;
};

export const clearedService = (observed: ServiceObservation) => observed.status === "owned" && observed.tombstone && observed.retainedInputsCleared &&
  observed.replicas === 0 && observed.endpoint === "dnsrr" && observed.tasks.every((task) => terminal.has(task.state));
