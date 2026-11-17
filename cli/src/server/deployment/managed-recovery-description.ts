import { createHash } from "node:crypto";
import { z } from "zod";
import { parseManagedApplicationPlan, managedApplicationDigest, managedMigrationDescription } from "../../contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { ServiceVersion } from "../../contracts/swarm-service.ts";
import { parseManagedGroupPreparation } from "./managed-group-preparation.ts";
import type { ManagedGroupPreparation } from "./managed-group-preparation.ts";
import { parseManagedConsumerState } from "./managed-consumer-state.ts";
import type { ManagedConsumerState } from "./managed-consumer-state.ts";
import type { ConsumerBaseline } from "./managed-consumer-rollout.ts";
import { migrationSequenceDigest } from "../../contracts/migration-sequence.ts";
import { migrationDescriptionForState, migrationAttemptBarrier } from "./migration-sequence.ts";
import { parseManagedServiceCompensation } from "./managed-service-compensation.ts";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const native = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().readonly();
const references = z.array(z.object({ name: z.string(), action: z.unknown(), native }).strict().readonly()).max(32).readonly();
const uniqueVersions = (values: readonly ServiceVersion[]) => Object.freeze(values.filter((value, index) => values.findIndex((other) => same(other, value)) === index).toSorted((left, right) => left.version - right.version));

/** No effects or admission. The lifecycle owner must fence the source phases and migration jobs before granting recovery effects. */
export const describeManagedRecovery = (input: ManagedApplicationPlan, previous: ManagedApplicationPlan | null, preparation: ManagedGroupPreparation, consumers: ManagedConsumerState | null, baselines: readonly ConsumerBaseline[]) => {
  const checked = parseManagedApplicationPlan(input); const old = previous === null ? null : parseManagedApplicationPlan(previous);
  if (!checked.ok || old !== null && !old.ok) throw new Error("invalid managed recovery plans"); const candidate = checked.value; const before = old === null ? null : old.value;
  const prefix = parseManagedGroupPreparation(preparation); const forward = consumers === null ? null : parseManagedConsumerState(consumers);
  const rawReferences = references.parse(baselines); const prior = Object.freeze(rawReferences.map((value) => { const action = parseManagedServiceAction(value.action); if (!action.ok) throw new Error("invalid managed recovery baseline"); return Object.freeze({ ...value, action: action.value }); }).toSorted((left, right) => left.name.localeCompare(right.name)));
  const owner = candidate.infrastructure.ownership; const plan = managedApplicationDigest(candidate); const previousDigest = before === null ? null : managedApplicationDigest(before);
  if (before !== null && (candidate.rollout.strategy !== "rolling" || !candidate.rollout.rollback_compatible) ||
    prefix.plan !== plan || prefix.app !== owner.app || prefix.incarnation !== owner.incarnation || prefix.dataOwner !== owner.dataOwner ||
    before !== null && (!same(candidate.infrastructure.ownership, before.infrastructure.ownership) || !same(candidate.host, before.host) || !same(candidate.infrastructure.overlay, before.infrastructure.overlay) || before.routes.some((route) => !candidate.hosts.includes(route.host)) || Object.values(before.services).some((service) => Object.values(service.inputs.environment).some((binding) => binding.kind === "secret" && !candidate.secrets.includes(binding.key)))) ||
    forward !== null && (forward.plan !== plan || forward.previous !== previousDigest || forward.preparation !== hash(prefix) || forward.run !== prefix.run || forward.action !== prefix.action || forward.app !== owner.app || forward.incarnation !== owner.incarnation || forward.dataOwner !== owner.dataOwner)) throw new Error("managed recovery scope or rollback authority disagrees");
  const migrations = candidate.rollout.migrations.length === 0 ? null : managedMigrationDescription(candidate, prefix.run);
  if (migrations !== null && !migrations.ok || prefix.sequencePlan !== (!migrations?.ok ? null : migrationSequenceDigest(migrations.value))) throw new Error("managed recovery migration description disagrees");
  if (prefix.sequence !== null) { if (!migrations?.ok) throw new Error("unexpected managed recovery migration sequence"); migrationDescriptionForState(prefix.sequence, migrations.value); }
  // A failed migration exit does not establish database outcome. Require fencing plus an applied/not-applied result or its audited resolution.
  if (prefix.sequence?.steps.some((step) => step.attempts.some((attempt) => attempt.execution !== null && migrationAttemptBarrier(attempt) === null) ||
    step.phase !== "applied" && step.attempts.some((attempt) => attempt.execution !== null) && step.resolution?.outcome !== "not-applied" && !step.attempts.some((attempt) => attempt.purpose === "probe" && attempt.execution?.evidence?.probe === "not-applied" && attempt.execution.evidence.kind === "succeeded"))) throw new Error("managed recovery requires resolved and fenced migration outcomes");
  const oldConsumers = Object.values(before?.services ?? {}).filter((service) => service.role !== "retained-dependency");
  if (new Set(prior.map((value) => value.name)).size !== prior.length || prior.length !== oldConsumers.length || prior.some((value) => {
    const service = before?.services[value.name]; return service === undefined || service.role === "retained-dependency" || value.action.plan !== managedServiceDigest(service) || value.action.app !== owner.app || value.action.incarnation !== owner.incarnation || value.action.dataOwner !== owner.dataOwner || value.action.service !== value.name || Number(value.action.action.split(":")[1]) >= Number(prefix.action.split(":")[1]) || !["apply", "restore"].includes(value.action.effect);
  }) || forward?.nodes.some((node) => { const ref = prior.find((value) => value.name === node.name); return !same(node.baseline, ref === undefined ? null : Object.freeze({ action: ref.action, native: ref.native })); })) throw new Error("managed recovery previous consumer references disagree");
  const retained = Object.freeze(Object.values(before?.services ?? {}).filter((service) => service.role === "retained-dependency").map((service) => {
    const target = candidate.services[service.service]; const node = prefix.nodes.find((node) => node.name === service.service);
    if (target === undefined || managedServiceDigest(service) !== managedServiceDigest(target) || node?.baseline?.kind !== "active" || node.baseline.action.plan !== managedServiceDigest(service)) throw new Error("managed recovery retained baseline is unavailable or changed");
    return Object.freeze({ name: service.service, action: node.baseline.action, native: node.baseline.native });
  }));
  const names = [...new Set([...Object.keys(candidate.services), ...Object.keys(before?.services ?? {})])].filter((name) => !retained.some((value) => value.name === name)).toSorted();
  if (names.length > 32 || prefix.nodes.length !== Object.values(candidate.services).filter((service) => service.role === "retained-dependency").length || prefix.nodes.some((node) => { const service = candidate.services[node.name]; return service?.role !== "retained-dependency" || managedServiceDigest(service) !== node.plan; })) throw new Error("managed recovery service set disagrees");
  const nodes = Object.freeze(names.map((name) => {
    const target = candidate.services[name]; const previous = before?.services[name]; const selected = previous ?? target; if (selected === undefined) throw new Error("managed recovery service missing");
    const reference = prior.find((value) => value.name === name); const consumer = forward?.nodes.find((node) => node.name === name); const dependency = prefix.nodes.find((node) => node.name === name);
    if (previous !== undefined && target?.role === "retained-dependency" || consumer !== undefined && consumer.target !== (target === undefined ? null : managedServiceDigest(target)) || dependency !== undefined && dependency.plan !== managedServiceDigest(selected)) throw new Error("managed recovery service role or digest disagrees");
    const versions = uniqueVersions([
      ...(reference === undefined ? [] : [reference.native]), ...(consumer?.baseline === null || consumer?.baseline === undefined ? [] : [consumer.baseline.native]),
      ...(consumer?.execution?.expected === null || consumer?.execution?.expected === undefined ? [] : [consumer.execution.expected]), ...(consumer?.execution?.verified === null || consumer?.execution?.verified === undefined ? [] : [consumer.execution.verified.native]),
      ...(consumer?.quiescence?.prior ?? []), ...(consumer?.quiescence?.steps.flatMap((step) => step.expected === null ? Object.freeze([]) : Object.freeze([step.expected])) ?? []), ...(consumer?.quiescence?.proof === null || consumer?.quiescence?.proof === undefined ? [] : [consumer.quiescence.proof.native]), ...(consumer?.ready === null || consumer?.ready === undefined ? [] : [consumer.ready.native]),
      ...(dependency?.baseline === null || dependency?.baseline === undefined ? [] : [dependency.baseline.native]), ...(dependency?.execution?.expected === null || dependency?.execution?.expected === undefined ? [] : [dependency.execution.expected]), ...(dependency?.execution?.verified === null || dependency?.execution?.verified === undefined ? [] : [dependency.execution.verified.native]), ...(dependency?.ready === null || dependency?.ready === undefined ? [] : [dependency.ready.native]),
    ]);
    // Reuse the executable child's identity/CAS validator before any parent recovery intent can be admitted.
    parseManagedServiceCompensation({ version: 1, action: { app: owner.app, incarnation: owner.incarnation, dataOwner: owner.dataOwner, service: name, action: prefix.action, plan: managedServiceDigest(selected), effect: "restore", deadline: 2 }, createdAt: 1,
      candidate: plan, previous: previousDigest, baseline: reference?.native ?? null, prior: versions, fences: [], attempts: [], barrier: null, phase: "recovering", reason: null, proof: null });
    return Object.freeze({ name, plan: managedServiceDigest(selected), baseline: reference?.native ?? null, prior: versions });
  }));
  return Object.freeze({ version: 1 as const, app: owner.app, incarnation: owner.incarnation, dataOwner: owner.dataOwner, run: prefix.run, action: prefix.action, plan, previous: previousDigest, preparation: hash(prefix), consumers: forward === null ? null : hash(forward), baselines: prior, retained, nodes });
};
export type ManagedRecoveryDescription = ReturnType<typeof describeManagedRecovery>;
export const managedRecoveryDigest = (description: ManagedRecoveryDescription) => hash(description);

/** Private immutable recovery input, revalidated whenever reopened from the artifact store. */
export const managedRecoverySnapshot = (input: unknown) => {
  const raw = z.object({ candidate: z.unknown(), previous: z.unknown().nullable(), preparation: z.unknown(), consumers: z.unknown().nullable(), baselines: references }).strict().parse(input);
  const candidate = parseManagedApplicationPlan(raw.candidate); const previous = raw.previous === null ? null : parseManagedApplicationPlan(raw.previous);
  if (!candidate.ok || previous !== null && !previous.ok) throw new Error("invalid managed recovery snapshot plans");
  const preparation = parseManagedGroupPreparation(raw.preparation); const consumers = raw.consumers === null ? null : parseManagedConsumerState(raw.consumers);
  const baselines = Object.freeze(raw.baselines.map((ref) => { const action = parseManagedServiceAction(ref.action); if (!action.ok) throw new Error("invalid managed recovery snapshot baseline"); return Object.freeze({ ...ref, action: action.value }); }).toSorted((left, right) => left.name.localeCompare(right.name)));
  const source = Object.freeze({ candidate: candidate.value, previous: previous === null ? null : previous.value, preparation, consumers, baselines });
  return Object.freeze({ source, description: describeManagedRecovery(source.candidate, source.previous, preparation, consumers, baselines) });
};
