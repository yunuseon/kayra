import { createHash } from "node:crypto";
import type { ServiceVersion } from "../../contracts/swarm-service.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import type { ManagedRemovalIntent } from "./managed-removal-intent.ts";
import { managedDeploymentEvidence } from "./managed-deployment-evidence.ts";
import { managedReleaseBaselines } from "./managed-release.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Inventory for the removal reconciler. Unknown work remains in the held checkpoint. */
export const managedRemovalInventory = async (
  intent: ManagedRemovalIntent,
  baseline: { readonly state: ManagedLifecycleStore; readonly source: ManagedLifecycleSource } | null,
  read: (digest: string) => Promise<string>,
) => {
  if (baseline === null) return Object.freeze({ intent, checkpoint: null, blocked: null, services: Object.freeze([]), jobs: Object.freeze([]), checks: Object.freeze([]) });
  const { state, source } = await managedDeploymentEvidence(baseline.state, baseline.source, { read });
  if (!same(state.owner, intent.owner) || Number(intent.action.split(":")[1]) <= state.sequence ||
    intent.createdAt < state.operation.createdAt) throw new Error("removal inventory does not own the deployment checkpoint");

  const operation = state.operation;
  const current = source.candidate.services;
  const previous = source.previous?.source.application.services ?? {};
  const retired = source.retired.map((item) => item.plan);
  const plans = [...Object.values(current), ...Object.values(previous), ...retired];
  if (plans.some((plan) => plan.mounts.some((mount) => !intent.volumes.some((volume) => same(volume, mount.volume))))) {
    throw new Error("removal inventory lacks owned volume identities");
  }

  const previousRefs = source.previous === null ? Object.freeze([]) : managedReleaseBaselines(source.previous);
  const services = [...new Set(plans.map((item) => item.service))].map((name) => {
    const plan = current[name] ?? previous[name] ?? retired.find((item) => item.service === name);
    if (plan === undefined) throw new Error("removal inventory service description missing");
    const consumer = operation.consumers?.nodes.find((item) => item.name === name);
    const quiescence = operation.quiescence?.nodes.find((item) => item.name === name);
    const preparation = operation.preparation?.nodes.find((item) => item.name === name);
    const recovery = operation.recovery?.nodes.find((item) => item.name === name)?.child;
    const retirement = source.retired.find((item) => item.plan.service === name)?.barrier;
    const barriers = [quiescence?.child, consumer?.quiescence, recovery?.barrier, retirement];
    const versions = [
      previousRefs.find((item) => item.name === name)?.native, source.retained.find((item) => item.name === name)?.native,
      quiescence?.baseline, consumer?.baseline?.native, consumer?.execution?.expected, consumer?.execution?.verified?.native,
      consumer?.ready?.native, preparation?.ready?.native, preparation?.execution?.expected, preparation?.execution?.verified?.native,
      ...barriers.map((barrier) => barrier?.proof?.native),
      ...barriers.flatMap((barrier) => Object.freeze((barrier?.steps ?? []).map((step) => step.expected))),
    ];
    const prior = Object.freeze(versions.filter((value): value is ServiceVersion => value != null)
      .filter((value, index, all) => all.findIndex((other) => same(value, other)) === index)
      .toSorted((a, b) => a.version - b.version));
    if (prior.length > 64 || new Set(prior.map((item) => item.id)).size > 1) throw new Error("removal inventory service identity conflicts");
    return Object.freeze({ name, plan, digest: managedServiceDigest(plan), prior });
  });
  const jobs = Object.freeze([...new Set((operation.preparation?.sequence?.steps ?? []).flatMap((step) => Object.freeze(step.attempts.map((attempt) => attempt.artifact))))].toSorted());
  const checks = Object.freeze([operation.verification, operation.recoveryVerification].flatMap((verification) =>
    Object.freeze((verification?.steps ?? []).flatMap((step) => {
      if (step.execution === null || step.execution.phase === "complete" || step.execution.executionDeadline === null) return Object.freeze([]);
      if (step.target === null || !services.some((item) => item.name === step.target?.action.service)) throw new Error("removal inventory unknown check lacks an owned target");
      return Object.freeze([step.target]);
    })),
  ));
  return Object.freeze({
    intent, checkpoint: hash(state), blocked: Object.freeze({ state, source }), jobs, checks,
    services: Object.freeze(services.toSorted((a, b) =>
      Number(a.plan.role === "retained-dependency") - Number(b.plan.role === "retained-dependency") || a.name.localeCompare(b.name))),
  });
};
