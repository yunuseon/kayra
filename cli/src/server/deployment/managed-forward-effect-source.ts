import { createHash } from "node:crypto";
import { z } from "zod";
import { parseManagedApplicationPlan, managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import { migrationReasonSchema } from "../../contracts/migration-resolution.ts";
import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { managedLifecycleDescription, managedLifecycleSourceDigest, parseManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import { managedForwardRecoveryBaseline, managedForwardRecoveryProposal } from "./managed-forward-recovery-proposal.ts";
import { managedRecoveryCheckTargets } from "./managed-recovery-safety.ts";
import { managedReleaseBaselines } from "./managed-release.ts";

const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const request = z.object({ run: z.uuid(), action: z.string().max(80), createdAt: time, reason: migrationReasonSchema }).strict().readonly();
const schema = z.object({ version: z.literal(1), kind: z.literal("managed-forward-effect-source"), decision: digest,
  baseline: z.object({ state: z.unknown(), source: z.unknown() }).strict().readonly(), candidate: z.unknown(), request, deadline: time,
}).strict().readonly();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Immutable cleanup description. A decision digest is a binding, never permission to mutate workloads or admission. */
export const managedForwardEffectSource = (input: unknown) => {
  const raw = schema.parse(input); const state = parseManagedLifecycleStore(raw.baseline.state); const description = managedLifecycleDescription(parseManagedLifecycleSource(raw.baseline.source)); const source = description.source;
  const candidate = parseManagedApplicationPlan(raw.candidate); if (!candidate.ok) throw new Error("invalid forward effect candidate");
  const operation = state.operation;
  if (operation.source !== managedLifecycleSourceDigest(source) || operation.run !== source.run || operation.action !== source.action || operation.createdAt !== source.createdAt ||
    operation.plan !== description.admission.planDigest || operation.previous !== description.previous || operation.previousPlan !== (description.admission.previous === null ? null : managedApplicationDigest(description.admission.previous)) ||
    operation.admissionDeadline !== description.admissionDeadline || operation.deadline !== description.deadline || !same(state.owner, source.candidate.infrastructure.ownership) ||
    source.version !== 3 && source.candidate.rollout.rollback_compatible || raw.request.createdAt < operation.enteredAt || raw.deadline !== raw.request.createdAt + 90_000) throw new Error("forward effect baseline binding disagrees");
  const policy = managedForwardRecoveryBaseline(state, source, candidate.value, raw.request);
  if (policy.retained.some((service) => { const target = candidate.value.services[service.service]; return target === undefined || managedServiceDigest(target) !== managedServiceDigest(service); })) throw new Error("forward effects require normalized unchanged retained dependencies");
  if (source.previous !== null && operation.quiescence?.phase !== "complete") throw new Error("forward effects require completed prior maintenance quiescence");
  const checks = managedRecoveryCheckTargets(state, source) ?? Object.freeze([]);
  if (checks.some((check) => source.candidate.services[check.target.action.service]?.role === "retained-dependency")) throw new Error("forward effects cannot stop a retained dependency to fence an uncertain check");
  return Object.freeze({ ...raw, baseline: Object.freeze({ state, source }), candidate: candidate.value });
};
export type ManagedForwardEffectSource = ReturnType<typeof managedForwardEffectSource>;
export const managedForwardEffectSourceDigest = (input: ManagedForwardEffectSource) => hash(managedForwardEffectSource(input));

/** Revalidates retained input generations and release history before retaining a successor cleanup source. No effects. */
export const prepareManagedForwardEffectSource = async (input: unknown, ports: Parameters<typeof managedForwardRecoveryProposal>[3]) => {
  const raw = schema.parse(input); const candidate = parseManagedApplicationPlan(raw.candidate); if (!candidate.ok) throw new Error("invalid forward effect candidate");
  const baseline = Object.freeze({ state: parseManagedLifecycleStore(raw.baseline.state), source: managedLifecycleDescription(parseManagedLifecycleSource(raw.baseline.source)).source });
  const proposal = await managedForwardRecoveryProposal(candidate.value, raw.request, baseline, ports);
  return managedForwardEffectSource({ ...raw, baseline, candidate: proposal.candidate });
};

/** Only consumers can be stopped. Maintenance has already fenced old-only consumers before the unsafe data effect. */
export const managedForwardEffectNodes = (input: ManagedForwardEffectSource) => {
  const value = managedForwardEffectSource(input); const { state, source } = value.baseline; const operation = state.operation;
  const current = Object.values(source.candidate.services).filter((service) => service.role !== "retained-dependency");
  const previous = Object.values(source.previous?.source.application.services ?? {}).filter((service) => service.role !== "retained-dependency");
  const checks = managedRecoveryCheckTargets(state, source) ?? Object.freeze([]);
  const baselines = source.previous === null ? Object.freeze([]) : managedReleaseBaselines(source.previous);
  return Object.freeze([...new Set([...current, ...previous].map((service) => service.service))].toSorted().map((name) => {
    const service = source.candidate.services[name] ?? source.previous?.source.application.services[name]; if (service === undefined || service.role === "retained-dependency") throw new Error("forward effect consumer inventory disagrees");
    const quiescence = operation.quiescence?.nodes.find((node) => node.name === name); const consumer = operation.consumers?.nodes.find((node) => node.name === name);
    const barriers = [quiescence?.child, consumer?.quiescence].filter((barrier) => barrier !== undefined && barrier !== null);
    const references = [baselines.find((item) => item.name === name)?.native, quiescence?.baseline, consumer?.baseline?.native, consumer?.execution?.expected, consumer?.execution?.verified?.native, consumer?.ready?.native];
    const versions = [...references.filter((native) => native !== undefined && native !== null), ...(quiescence?.prior ?? []), ...barriers.flatMap((barrier) => Object.freeze([...barrier.prior, ...barrier.steps.flatMap((step) => step.expected === null ? Object.freeze([]) : Object.freeze([step.expected])), ...(barrier.proof === null ? Object.freeze([]) : Object.freeze([barrier.proof.native]))])), ...checks.filter((check) => check.target.action.service === name).map((check) => check.native)];
    const prior = Object.freeze(versions.filter((native, index) => versions.findIndex((other) => same(native, other)) === index).toSorted((a, b) => a.version - b.version));
    if (prior.length > 64 || new Set(prior.map((native) => native.id)).size > 1) throw new Error("forward effect native inventory disagrees");
    return Object.freeze({ name, service, plan: managedServiceDigest(service), prior,
      waitFor: Object.freeze(current.filter((dependent) => dependent.dependencies.some((dependency) => dependency.service === name)).map((dependent) => dependent.service).toSorted()),
      checks: Object.freeze(checks.filter((check) => check.target.action.service === name)),
    });
  }));
};
