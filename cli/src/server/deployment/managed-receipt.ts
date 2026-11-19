import { parseManagedDeploymentReceipt } from "../../contracts/managed-deployment-receipt.ts";
import { parseManagedLifecycleRequest } from "./managed-lifecycle-request.ts";
import { managedLifecycleDescription, managedLifecycleSourceDigest } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleRequest } from "./managed-lifecycle-request.ts";

/** Projection of an authenticated acceptance record. It makes no new assertion about live runtime health or the current active release. */
export const managedReceipt = (sourceInput: ManagedLifecycleSource, requestInput: ManagedLifecycleRequest) => {
  const description = managedLifecycleDescription(sourceInput); const source = description.source; const request = parseManagedLifecycleRequest(requestInput);
  if (request.run !== source.run || request.action !== source.action || request.source !== managedLifecycleSourceDigest(source) || request.plan !== description.admission.planDigest ||
    JSON.stringify(request.owner) !== JSON.stringify(source.candidate.infrastructure.ownership) || request.createdAt !== source.createdAt || request.admissionDeadline !== description.admissionDeadline || request.deadline !== description.deadline) throw new Error("managed receipt source binding disagrees");
  const receipt = parseManagedDeploymentReceipt({ version: 3, protocol: "managed-v3", app: request.owner.app, request: request.run, commit: source.candidate.commit,
    plan: request.plan, createdAt: request.createdAt, admissionDeadline: request.admissionDeadline, deadline: request.deadline,
    phase: request.completion === null ? "accepted" : "complete", outcome: request.completion?.outcome ?? null, disposition: request.completion?.disposition ?? null });
  if (!receipt.ok) throw new Error(receipt.error); return receipt.value;
};
