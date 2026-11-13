import { parseDeploymentStatus } from "../../contracts/deployment-status.ts";
import type { Runtime } from "../../contracts/rollout.ts";
import type { LifecycleFence } from "./lifecycle-fence.ts";
import type { HttpState, HttpVerifiedRelease } from "./http-state.ts";
import { httpReleasePlan } from "./http-state.ts";
import type { parseRolloutRequest } from "./rollout-request.ts";

export const deploymentStatus = (app: string, incarnation: string, runtime: Runtime, lifecycle: LifecycleFence["lifecycle"]["phase"], state?: HttpState, rollout?: ReturnType<typeof parseRolloutRequest>) => {
  const target = (digest: string | null | undefined) => {
    const request = state?.requests.find((item) => httpReleasePlan(item) === digest);
    return request === undefined ? null : Object.freeze({ plan: httpReleasePlan(request), commit: request.commit });
  };
  const verified = (release: HttpVerifiedRelease | null | undefined) => release === null || release === undefined ? null : Object.freeze({
    plan: httpReleasePlan(release), commit: release.commit, verifiedAt: release.verifiedAt,
  });
  const latest = state?.requests.at(-1);
  const preparing = rollout !== undefined && !state?.requests.some((item) => item.request === rollout.preparation.run) ? rollout : undefined;
  const preparation = preparing?.preparation;
  const completion = preparing?.completion;
  const requested = preparing === undefined ? target(state?.requested) : Object.freeze({ plan: preparing.preparation.plan, commit: preparing.commit });
  const parsed = parseDeploymentStatus({ version: 1, app, incarnation, runtime, lifecycle,
    verification: runtime === "compose" ? "legacy-unverified" : state?.active === null || state?.active === undefined ? "unverified" : "verified",
    requested, desired: preparing === undefined ? target(state?.desired) : completion === undefined ? requested : target(completion.previous), verifiedActive: verified(state?.active), lastKnownGood: verified(state?.lastKnownGood),
    operation: latest === undefined || preparing !== undefined ? null : { request: latest.request, phase: latest.phase, reason: latest.reason, cancelRequestedAt: latest.cancelRequestedAt,
      updateDeadline: latest.deadline, recoveryDeadline: latest.recoveryDeadline, recovery: latest.recovery?.kind ?? null },
    preparation: preparation === undefined || preparing === undefined ? null : { request: preparation.run,
      phase: completion?.outcome ?? (preparation.phase === "ready" ? "ready-for-http" : preparation.phase === "prepared" && preparing.admitted ? "admitted" : preparation.phase),
      reason: completion?.reason ?? preparation.reason, admissionDeadline: preparing.admissionDeadline, deadline: preparation.deadline, migrationDeadline: preparation.migrationDeadline,
      httpDeadline: preparation.httpDeadline, completedAt: completion?.at ?? null, step: preparation.sequence?.steps[preparation.sequence.position]?.id ?? null },
    requiredAction: preparation?.phase === "held" || preparing === undefined && latest?.phase === "held" ? "inspect-and-resolve" : "none", runtimeObservation: "not-observed",
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
