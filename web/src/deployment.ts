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
  const progress = status.version === 3 ? status.recovery ?? null : null;
  const recoveryPhase = progress === null ? null : ({ "fencing-checks": "Stopping interrupted checks", restoring: "Restoring previous services", "checking-restored": "Verifying restored release", complete: "Recovery verified", held: "Recovery blocked" } as const)[progress.phase];
  const matching = health?.app === status.app && health.incarnation === status.incarnation && health.runtime === status.runtime;
  const runtime = matching ? health.state : health === undefined || health === null ? "Not observed" : "Registration changed; refresh observations";
  const runtimeTone = typed<Tone>(matching && health.state === "available" ? "ok" : matching && ["unhealthy", "missing", "mismatch", "unavailable"].includes(health.state) ? "bad" : "muted");
  const cancelRequest = current === null || ["idle", "succeeded", "failed", "cancelled", "held", "cancelling", "settling", "complete"].includes(phase) ||
    status.version === 3 && ["recovering", "recovery-verifying"].includes(phase) || current.cancelRequestedAt !== null
    ? null : "run" in current ? current.run : current.request;
  const migrationResolution = status.requiredAction !== "inspect-and-resolve" ? null : status.version === 3
    ? status.migrations.phase === "held" && status.migrations.step !== null &&
      ["probe-unknown", "unsafe-outcome"].includes(status.migrations.reason ?? "") &&
      !status.migrations.resolutions.some((value) => value.step === status.migrations.step)
      ? Object.freeze({ run: status.operation.run, step: status.migrations.step }) : null
    : status.preparation?.step == null ? null : Object.freeze({ run: status.preparation.request, step: status.preparation.step });
  return Object.freeze({ phase, phaseTone, recoveryPhase, pendingCheckContainers: progress === null ? 0 : progress.checks.containers - progress.checks.stopped, recovery: managedRecovery ?? (recovery === null || recovery === undefined ? "None recorded" : recoveryText[recovery]), runtime, runtimeTone,
    rollback: status.version === 1 ? null : ({ eligible: "Permitted", "no-previous-release": "No previous release", "application-incompatible": "Application declares rollback unsafe", "data-fenced": "Data changed; forward recovery required" } as const)[status.rollback],
    action: status.requiredAction !== "inspect-and-resolve" ? "None required" : status.version === 3 && status.rollback === "data-fenced" ? "Forward recovery is required; preserve retained data and inspect the blocked operation" : progress?.phase === "held" && progress.checks.containers > progress.checks.stopped ? "Prove the interrupted check containers stopped before restoring services" : "Inspect the blocked operation and record a recovery decision",
    active: status.verifiedActive?.commit ?? null, desired: status.desired?.commit ?? null, requested: status.requested?.commit ?? null, lastKnownGood: status.lastKnownGood?.commit ?? null,
    observedAt: matching ? health.observedAt : null, services: matching ? health.services : Object.freeze([]),
    cancelRequest, migrationResolution,
  });
};
