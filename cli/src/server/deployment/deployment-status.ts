import { parseDeploymentStatus } from "../../contracts/deployment-status.ts";
import type { Runtime } from "../../contracts/rollout.ts";
import type { LifecycleFence } from "./lifecycle-fence.ts";
import type { HttpState, HttpVerifiedRelease } from "./http-state.ts";

export const deploymentStatus = (app: string, incarnation: string, runtime: Runtime, lifecycle: LifecycleFence["lifecycle"]["phase"], state?: HttpState) => {
  const target = (digest: string | null | undefined) => {
    const request = state?.requests.find((item) => item.plan === digest);
    return request === undefined ? null : Object.freeze({ plan: request.plan, commit: request.commit });
  };
  const verified = (release: HttpVerifiedRelease | null | undefined) => release === null || release === undefined ? null : Object.freeze({
    plan: release.plan, commit: release.commit, verifiedAt: release.verifiedAt,
  });
  const latest = state?.requests.at(-1);
  const parsed = parseDeploymentStatus({ version: 1, app, incarnation, runtime, lifecycle,
    verification: runtime === "compose" ? "legacy-unverified" : state?.active === null || state?.active === undefined ? "unverified" : "verified",
    requested: target(state?.requested), desired: target(state?.desired), verifiedActive: verified(state?.active), lastKnownGood: verified(state?.lastKnownGood),
    operation: latest === undefined ? null : { request: latest.request, phase: latest.phase, reason: latest.reason,
      updateDeadline: latest.deadline, recoveryDeadline: latest.recoveryDeadline, recovery: latest.recovery?.kind ?? null },
    requiredAction: latest?.phase === "held" ? "inspect-and-resolve" : "none", runtimeObservation: "not-observed",
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
