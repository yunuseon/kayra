import { createHash } from "node:crypto";
import { z } from "zod";
import { managedVerificationSnapshot } from "./managed-verification-source.ts";
import { parseManagedGroupVerification } from "./managed-group-verification.ts";
import { describeManagedCheck } from "./managed-check-description.ts";
import { containerCheckDigest } from "../../contracts/container-check.ts";
import { parseManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { routedHttp } from "./http-convergence.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const schema = z.object({ version: z.literal(1), source: z.unknown(), verification: z.unknown() }).strict().readonly();
/** Historical, immutable release evidence. Only the lifecycle writer may promote a freshly completed owned verification; parsing alone grants no effects or current health. */
export const parseManagedRelease = (input: unknown) => {
  const raw = schema.parse(input); const snapshot = managedVerificationSnapshot(raw.source); const verification = parseManagedGroupVerification(raw.verification); const proof = verification.verified;
  const owner = snapshot.application.infrastructure.ownership;
  if (verification.phase !== "verified" || proof === null || verification.source !== hash(snapshot.source) || verification.plan !== snapshot.plan || verification.run !== snapshot.run || verification.checkRun !== snapshot.checkRun ||
    verification.app !== owner.app || verification.incarnation !== owner.incarnation || verification.dataOwner !== owner.dataOwner || verification.createdAt !== snapshot.createdAt || verification.deadline !== snapshot.deadline ||
    verification.steps.length !== snapshot.application.rollout.checks.length || proof.observations.length !== snapshot.witnesses.length) throw new Error("managed release verification source or scope disagrees");
  for (const witness of snapshot.witnesses) {
    const observation = proof.observations.find((value) => value.name === witness.name); const service = snapshot.application.services[witness.name];
    if (observation === undefined || service === undefined || observation.native.id !== witness.native.id || observation.native.version < witness.native.version ||
      (service.role === "http" ? observation.routed === null || !routedHttp(witness.action, observation.routed, proof.at) : observation.routed !== null)) throw new Error("managed release native or routed evidence disagrees");
  }
  for (const [index, step] of verification.steps.entries()) {
    const declaration = snapshot.application.rollout.checks[index]; const target = step.target; const observation = proof.observations.find((value) => value.name === step.service); const witness = snapshot.witnesses.find((value) => value.name === step.service);
    if (declaration?.id !== step.id || declaration.service !== step.service || target === null || step.deadline === null || witness === undefined || observation === undefined ||
      !same(target.action, witness.action) || target.service !== observation.native.id || target.task !== observation.task) throw new Error("managed release check target disagrees");
    const description = describeManagedCheck(snapshot.application, snapshot.checkRun, step.id, target, step.deadline);
    if (!description.ok || containerCheckDigest(description.value) !== step.plan) throw new Error("managed release check command or deadline disagrees");
  }
  return Object.freeze({ version: 1 as const, source: snapshot.source, verification });
};
export type ManagedRelease = ReturnType<typeof parseManagedRelease>;
export const managedReleaseDigest = (input: ManagedRelease) => hash(parseManagedRelease(input));
/** Historical release restoration reuses the exact workload and checks without rerunning migration commands. */
export const managedRestorePlan = (release: ManagedRelease) => {
  const application = parseManagedRelease(release).source.application;
  if (!application.rollout.rollback_compatible) throw new Error("managed restore requires application rollback compatibility");
  const restore = parseManagedApplicationPlan({ ...application, rollout: { ...application.rollout, migrations: [] } });
  if (!restore.ok) throw new Error(restore.error);
  return restore.value;
};
/** Immutable prior workload references are reconstructed from verified evidence, never filenames or a moving branch. */
export const managedReleaseBaselines = (input: ManagedRelease) => {
  const release = parseManagedRelease(input); const snapshot = managedVerificationSnapshot(release.source); const observations = release.verification.verified;
  if (observations === null) throw new Error("managed release observations missing");
  return Object.freeze(snapshot.witnesses.map((witness) => {
    const current = observations.observations.find((value) => value.name === witness.name); if (current === undefined) throw new Error("managed release witness missing");
    return Object.freeze({ name: witness.name, action: witness.action, native: current.native });
  }));
};
