import type { ManagedDeploymentStatus } from "../../contracts/managed-deployment-status.ts";
import type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { typed } from "../../lib/typed.ts";

/** Published progress contains counts, not native IDs or private cessation records. Certification remains separate from current runtime health. */
export const managedRecoveryProgress = (state: ManagedLifecycleStore) => {
  const operation = state.operation; const recovery = operation.recovery;
  if (operation.recoveryDeadline === null) return null;
  const checks = recovery?.cessation?.state;
  const containers = checks?.nodes.reduce((count, node) => count + node.checks.length, 0) ?? operation.verification?.steps.filter((step) => step.execution !== null && step.execution.phase !== "complete" && step.execution.executionDeadline !== null).length ?? 0;
  const stopped = checks?.nodes.reduce((count, node) => count + node.proofs.length, 0) ?? 0;
  const phase = operation.phase === "held" ? "held" : operation.outcome !== null ? "complete" : (containers > stopped || recovery?.phase === "fencing-checks") ? "fencing-checks" : recovery?.phase === "verified" ? "checking-restored" : "restoring";
  const reason = operation.phase !== "held" ? null : operation.reason === "deadline" || recovery?.reason === "deadline" ? "deadline" : operation.reason === "authorization" ? "authorization" : operation.reason === "recovery-verification" ? "verification" : recovery?.reason ?? "runtime";
  return Object.freeze(typed<NonNullable<ManagedDeploymentStatus["recovery"]>>({ phase, reason, deadline: operation.recoveryDeadline, checks: Object.freeze({ containers, stopped }) }));
};
