import { httpReleasePlan } from "./http-state.ts";
import type { HttpOperation } from "./http-state.ts";
import type { parseRolloutRequest } from "./rollout-request.ts";

type Owner = ReturnType<typeof parseRolloutRequest>;
type Owners = { readonly rollout?: Owner | undefined; readonly rollouts?: readonly Owner[] | undefined };

/** Scheduling authority belongs to the parent reservation; HTTP keeps its own execution deadline. */
export const httpAdmissionDeadline = (operation: HttpOperation, envelope: Owners) => {
  if (operation.deployment === undefined) return operation.deadline;
  const owner = [...(envelope.rollouts ?? []), ...(envelope.rollout === undefined ? [] : [envelope.rollout])].find((item) => item.preparation.run === operation.request);
  if (owner === undefined || !owner.admitted || owner.ticket !== operation.ticket || owner.action !== operation.action || owner.commit !== operation.commit ||
    owner.preparation.phase !== "ready" || owner.preparation.plan !== httpReleasePlan(operation) || owner.preparation.workload !== operation.plan || owner.preparation.httpDeadline !== operation.deadline) throw new Error("HTTP effect lacks its admitted complete rollout handoff");
  return owner.admissionDeadline;
};
