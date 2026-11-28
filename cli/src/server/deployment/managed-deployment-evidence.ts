import { createHash } from "node:crypto";
import { managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import type { BuildPorts } from "../../contracts/build-artifact.ts";
import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { managedLifecycleDescription, parseManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import { parseManagedRelease } from "./managed-release.ts";

/** Shared owner-only validation for public read models; historical evidence grants no runtime effect or current health. */
export const managedDeploymentEvidence = async (input: unknown, sourceInput: unknown, ports: Pick<BuildPorts, "read">) => {
  const state = parseManagedLifecycleStore(input); const description = managedLifecycleDescription(parseManagedLifecycleSource(sourceInput)); const source = description.source; const operation = state.operation;
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  if (!same(state.owner, source.candidate.infrastructure.ownership) || operation.source !== createHash("sha256").update(JSON.stringify(source)).digest("hex") ||
    operation.run !== source.run || operation.action !== source.action || operation.createdAt !== source.createdAt || operation.plan !== description.admission.planDigest ||
    operation.previous !== description.previous || operation.previousPlan !== (source.previous === null ? null : managedApplicationDigest(source.previous.source.application)) ||
    operation.admissionDeadline !== description.admissionDeadline || operation.deadline !== description.deadline) throw new Error("managed status source disagrees");
  const verified = async (pointer: typeof state.active) => {
    if (pointer === null) return null;
    const bytes = await ports.read(pointer.record); const release = parseManagedRelease(JSON.parse(bytes)); const application = release.source.application;
    if (createHash("sha256").update(bytes).digest("hex") !== pointer.record || bytes !== JSON.stringify(release) || !same(application.infrastructure.ownership, state.owner) ||
      managedApplicationDigest(application) !== pointer.plan || release.verification.run !== pointer.run || release.verification.verified?.at !== pointer.verifiedAt) throw new Error("managed status verified release disagrees");
    return Object.freeze({ release, pointer });
  };
  const [prior, lastGood] = await Promise.all([verified(state.active), verified(state.lastGood)]);
  const active = prior?.pointer.epoch === state.compatibilityEpoch ? prior : null;
  return Object.freeze({ state, source, active, lastGood });
};
