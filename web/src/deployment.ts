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

export const deploymentView = (status: DeploymentStatus, health?: DeploymentHealth) => {
  const current = status.operation ?? status.preparation;
  const phase = current?.phase ?? "idle";
  const phaseTone = typed<Tone>(phase === "succeeded" ? "ok" : phase === "failed" || phase === "held" ? "bad" : phase === "cancelled" ? "warn" : phase === "idle" ? "muted" : "active");
  const recovery = current?.recovery;
  const matching = health?.app === status.app && health.incarnation === status.incarnation && health.runtime === status.runtime;
  const runtime = matching ? health.state : health === undefined ? "Not observed" : "Registration changed; refresh observations";
  const runtimeTone = typed<Tone>(matching && health.state === "available" ? "ok" : matching && ["unhealthy", "missing", "mismatch", "unavailable"].includes(health.state) ? "bad" : "muted");
  return Object.freeze({ phase, phaseTone, recovery: recovery === null || recovery === undefined ? "None recorded" : recoveryText[recovery], runtime, runtimeTone,
    action: status.requiredAction === "inspect-and-resolve" ? "Inspect the blocked operation and record a recovery decision" : "None required",
    active: status.verifiedActive?.commit ?? null, desired: status.desired?.commit ?? null, requested: status.requested?.commit ?? null, lastKnownGood: status.lastKnownGood?.commit ?? null,
    observedAt: matching ? health.observedAt : null, services: matching ? health.services : Object.freeze([]),
    cancelRequest: current !== null && !["idle", "succeeded", "failed", "cancelled", "held", "cancelling"].includes(phase) && current.cancelRequestedAt === null ? current.request : null,
  });
};
