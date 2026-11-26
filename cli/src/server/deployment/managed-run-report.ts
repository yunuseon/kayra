import type { RunAnswer } from "../../contracts/reporting.ts";
import type { ManagedDeploymentReadPort } from "../../contracts/managed-deployment-read.ts";
import type { ManagedLifecycleRequest } from "./managed-lifecycle-request.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { managedDeploymentEvidence } from "./managed-deployment-evidence.ts";
import { matchesManagedRequestCompletion } from "./managed-lifecycle-request.ts";
import { typed } from "../../lib/typed.ts";

export const managedRunReport = async (request: ManagedLifecycleRequest, source: ManagedLifecycleSource, state: ManagedLifecycleStore | undefined,
  ports: Pick<ManagedDeploymentReadPort, "read">, retirementAt?: number) => {
  const completion = request.completion;
  if (completion !== null && (state === undefined ? completion.rootSnapshot !== null : !matchesManagedRequestCompletion(completion, state))) {
    throw new Error("managed run report completion evidence disagrees");
  }
  const evidence = state === undefined ? null : await managedDeploymentEvidence(state, source, ports);
  const active = completion?.outcome === "removed" ? null : evidence?.active ?? null;
  const phase = completion === null ? state?.operation.phase ?? "accepted" : "complete";
  const outcome = completion?.outcome ?? state?.operation.outcome ?? null;
  const finished = completion?.outcome === "removed" ? retirementAt : phase === "complete" && completion?.outcome !== "superseded" ? state?.operation.enteredAt : undefined;
  const commit = active?.release.source.application.commit;
  const row = typed<RunAnswer>({
    id: request.run,
    state: phase === "complete" ? outcome === "deployed" ? "success" : outcome === "superseded" ? "superseded" : "failure" :
      phase === "accepted" ? "queued" : phase === "held" ? "failure" : "running",
    why: source.restore !== null ? "restore" : source.version === 3 ? "forward recovery" : "deploy",
    what: source.candidate.rollout.strategy,
    sha: source.candidate.commit,
    started: new Date(request.createdAt).toISOString(),
    ...(finished === undefined ? {} : { finished: new Date(finished).toISOString() }),
    managed: Object.freeze({ protocol: "managed-v3", phase, outcome, requiredAction: phase === "held" ? "inspect-and-resolve" : "none", activeRelease: commit ?? null }),
  });
  return Object.freeze({ row, live: active === null || commit === undefined ? undefined : Object.freeze({ sha: commit, time: new Date(active.pointer.verifiedAt).toISOString() }) });
};
