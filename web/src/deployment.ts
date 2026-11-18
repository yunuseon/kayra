import type { DeploymentHealth, DeploymentStatus, Tone } from "../../cli/src/clients/wire/contract.gen.ts";
import { typed } from "./typed.ts";

const recoveryText = {
  "automatic-rollback": "Previous release restored by the runtime",
  "previous-preserved": "Previous release preserved",
  compensated: "Previous release restored by the coordinator",
  "removed-unverified": "Unverified workload removed",
  unstarted: "Workload was never started",
  "no-active-release": "No certified active release",
} as const;

export const deploymentView = (status: NonNullable<DeploymentStatus>, health?: DeploymentHealth) => {
  const current = status.version === 3 ? status.operation : status.operation ?? status.preparation;
  const phase = current?.phase ?? "idle";
  const phaseTone = typed<Tone>(phase === "succeeded" || status.version === 3 && status.operation.outcome === "deployed" ? "ok" : phase === "failed" || phase === "held" || status.version === 3 && status.operation.outcome === "absent" ? "bad" : phase === "cancelled" || status.version === 3 && ["rolled-back", "unchanged"].includes(status.operation.outcome ?? "") ? "warn" : phase === "idle" ? "muted" : "active");
  const recovery = status.version === 1 ? (status.operation ?? status.preparation)?.recovery : null;
  const managedRecovery = status.version !== 3 || status.operation.outcome === null ? null : ({ deployed: "Deployment verified", "rolled-back": "Previous release restored", unchanged: "Previous release preserved", absent: "No certified active release" } as const)[status.operation.outcome];
  const matching = health?.app === status.app && health.incarnation === status.incarnation && health.runtime === status.runtime;
  const runtime = matching ? health.state : health === undefined || health === null ? "Not observed" : "Registration changed; refresh observations";
  const runtimeTone = typed<Tone>(matching && health.state === "available" ? "ok" : matching && ["unhealthy", "missing", "mismatch", "unavailable"].includes(health.state) ? "bad" : "muted");
  return Object.freeze({ phase, phaseTone, recovery: managedRecovery ?? (recovery === null || recovery === undefined ? "None recorded" : recoveryText[recovery]), runtime, runtimeTone,
    rollback: status.version === 1 ? null : ({ eligible: "Permitted", "no-previous-release": "No previous release", "application-incompatible": "Application declares rollback unsafe", "data-fenced": "Data changed; forward recovery required" } as const)[status.rollback],
    action: status.requiredAction === "inspect-and-resolve" ? "Inspect the blocked operation and record a recovery decision" : "None required",
    active: status.verifiedActive?.commit ?? null, desired: status.desired?.commit ?? null, requested: status.requested?.commit ?? null, lastKnownGood: status.lastKnownGood?.commit ?? null,
    observedAt: matching ? health.observedAt : null, services: matching ? health.services : Object.freeze([]),
    cancelRequest: status.version === 1 && current !== null && !["idle", "succeeded", "failed", "cancelled", "held", "cancelling"].includes(phase) && current.cancelRequestedAt === null ? (status.operation ?? status.preparation)?.request ?? null : null,
  });
};
