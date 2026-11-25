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
import { managedMaintenanceSnapshot } from "./managed-maintenance-quiescence.ts";
import { parseManagedServiceCompensation } from "./managed-service-compensation.ts";
import { managedCessationChecks } from "./managed-check-cessation-state.ts";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const native = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().readonly();
const references = z.array(z.object({ name: z.string(), action: z.unknown(), native }).strict().readonly()).max(32).readonly();
const uniqueVersions = (values: readonly ServiceVersion[]) => Object.freeze(values.filter((value, index) => values.findIndex((other) => same(other, value)) === index).toSorted((left, right) => left.version - right.version));

/** No effects or admission. The lifecycle owner must fence the source phases and migration jobs before granting recovery effects. */
export const describeManagedRecovery = (input: ManagedApplicationPlan, previous: ManagedApplicationPlan | null, preparation: ManagedGroupPreparation | null, consumers: ManagedConsumerState | null, baselines: readonly ConsumerBaseline[], maintenance?: unknown, retainedReferences: readonly ConsumerBaseline[] = [], checkTargets?: unknown) => {
  const checked = parseManagedApplicationPlan(input); const old = previous === null ? null : parseManagedApplicationPlan(previous);
  if (!checked.ok || old !== null && !old.ok) throw new Error("invalid managed recovery plans"); const candidate = checked.value; const before = old === null ? null : old.value;
  const prefix = preparation === null ? null : parseManagedGroupPreparation(preparation); const forward = consumers === null ? null : parseManagedConsumerState(consumers);
  const rawReferences = references.parse(baselines); const prior = Object.freeze(rawReferences.map((value) => { const action = parseManagedServiceAction(value.action); if (!action.ok) throw new Error("invalid managed recovery baseline"); return Object.freeze({ ...value, action: action.value }); }).toSorted((left, right) => left.name.localeCompare(right.name)));
  const stopped = maintenance === undefined || maintenance === null ? null : managedMaintenanceSnapshot(maintenance);
  const origin = prefix ?? stopped?.certificate; if (origin === undefined) throw new Error("managed recovery origin is missing");
  const checks = checkTargets === undefined ? undefined : managedCessationChecks(checkTargets, candidate, origin.action);
  if (checks !== undefined && (forward?.phase !== "ready" || checks.some((item) => { const node = forward.nodes.find((node) => node.name === item.target.action.service); return node?.ready?.kind !== "running" || !same(node.ready.native, item.native) || !same(node.ready.action, item.target.action); }))) throw new Error("managed recovery check witnesses disagree");
  const activeRetained = Object.freeze(references.parse(retainedReferences).map((value) => { const action = parseManagedServiceAction(value.action); if (!action.ok) throw new Error("invalid managed recovery retained reference"); return Object.freeze({ ...value, action: action.value }); }));
  if (prefix === null ? before === null || forward !== null : activeRetained.length !== 0) throw new Error("managed recovery preparation coverage disagrees");
  const owner = candidate.infrastructure.ownership; const plan = managedApplicationDigest(candidate); const previousDigest = before === null ? null : managedApplicationDigest(before);
  if (before !== null && (!candidate.rollout.rollback_compatible) ||
    origin.plan !== plan || origin.app !== owner.app || origin.incarnation !== owner.incarnation || origin.dataOwner !== owner.dataOwner ||
    before !== null && (!same(candidate.infrastructure.ownership, before.infrastructure.ownership) || !same(candidate.host, before.host) || !same(candidate.infrastructure.overlay, before.infrastructure.overlay) || before.routes.some((route) => !candidate.hosts.includes(route.host)) || Object.values(before.services).some((service) => Object.values(service.inputs.environment).some((binding) => binding.kind === "secret" && !candidate.secrets.includes(binding.key)))) ||
    forward !== null && (forward.plan !== plan || forward.previous !== previousDigest || forward.preparation !== hash(prefix) || forward.run !== origin.run || forward.action !== origin.action || forward.app !== owner.app || forward.incarnation !== owner.incarnation || forward.dataOwner !== owner.dataOwner)) throw new Error("managed recovery scope or rollback authority disagrees");
  if (candidate.rollout.strategy === "maintenance" ? stopped === null || prefix !== null && (prefix.version !== 2 || hash(stopped) !== prefix.maintenance || stopped.certificate.phase !== "complete" || stopped.certificate.verifiedAt !== prefix.createdAt) || stopped.certificate.run !== origin.run || stopped.certificate.action !== origin.action || !same(stopped.source.candidate, candidate) || !same(stopped.source.previous, before) || !same(stopped.source.baselines.map(({ name, action, native }) => Object.freeze({ name, action, native })).toSorted((a, b) => a.name.localeCompare(b.name)), prior) || forward !== null && (forward.version !== 2 || prefix?.version !== 2 || forward.maintenance !== prefix.maintenance) : stopped !== null || prefix?.version !== 1 || forward !== null && forward.version !== 1) throw new Error("managed recovery maintenance evidence disagrees");
  const migrations = prefix === null || candidate.rollout.migrations.length === 0 ? null : managedMigrationDescription(candidate, origin.run);
  if (prefix !== null && (migrations !== null && !migrations.ok || prefix.sequencePlan !== (!migrations?.ok ? null : migrationSequenceDigest(migrations.value)))) throw new Error("managed recovery migration description disagrees");
  if (prefix !== null && prefix.sequence !== null) { if (!migrations?.ok) throw new Error("unexpected managed recovery migration sequence"); migrationDescriptionForState(prefix.sequence, migrations.value); }
  // A failed migration exit does not establish database outcome. Require fencing plus an applied/not-applied result or its audited resolution.
  if (prefix?.sequence?.steps.some((step) => step.attempts.some((attempt) => attempt.execution !== null && migrationAttemptBarrier(attempt) === null) ||
    step.phase !== "applied" && step.attempts.some((attempt) => attempt.execution !== null) && step.resolution?.outcome !== "not-applied" && !step.attempts.some((attempt) => attempt.purpose === "probe" && attempt.execution?.evidence?.probe === "not-applied" && attempt.execution.evidence.kind === "succeeded"))) throw new Error("managed recovery requires resolved and fenced migration outcomes");
  const oldConsumers = Object.values(before?.services ?? {}).filter((service) => service.role !== "retained-dependency");
  if (new Set(prior.map((value) => value.name)).size !== prior.length || prior.length !== oldConsumers.length || prior.some((value) => {
    const service = before?.services[value.name]; return service === undefined || service.role === "retained-dependency" || value.action.plan !== managedServiceDigest(service) || value.action.app !== owner.app || value.action.incarnation !== owner.incarnation || value.action.dataOwner !== owner.dataOwner || value.action.service !== value.name || Number(value.action.action.split(":")[1]) >= Number(origin.action.split(":")[1]) || !["apply", "restore"].includes(value.action.effect);
  }) || forward?.nodes.some((node) => { const ref = prior.find((value) => value.name === node.name); return !same(node.baseline, ref === undefined ? null : Object.freeze({ action: ref.action, native: ref.native })); })) throw new Error("managed recovery previous consumer references disagree");
  const retained = Object.freeze(Object.values(before?.services ?? {}).filter((service) => service.role === "retained-dependency").map((service) => {
    const target = candidate.services[service.service]; const node = prefix?.nodes.find((node) => node.name === service.service);
    const reference = prefix === null ? activeRetained.find((value) => value.name === service.service) : node?.baseline?.kind === "active" ? node.baseline : undefined;
    if (target === undefined || managedServiceDigest(service) !== managedServiceDigest(target) || reference?.action.plan !== managedServiceDigest(service) || reference.action.app !== owner.app || reference.action.incarnation !== owner.incarnation || reference.action.dataOwner !== owner.dataOwner || reference.action.service !== service.service || !["apply", "restore"].includes(reference.action.effect) || Number(reference.action.action.split(":")[1]) >= Number(origin.action.split(":")[1])) throw new Error("managed recovery retained baseline is unavailable or changed");
    return Object.freeze({ name: service.service, action: reference.action, native: reference.native });
  }));
  if (prefix === null && (new Set(activeRetained.map((value) => value.name)).size !== activeRetained.length || activeRetained.length !== retained.length)) throw new Error("managed recovery retained coverage disagrees");
  const names = [...new Set([...(prefix === null ? [] : Object.keys(candidate.services)), ...Object.keys(before?.services ?? {})])].filter((name) => !retained.some((value) => value.name === name)).toSorted();
  if (names.length > 32 || prefix !== null && (prefix.nodes.length !== Object.values(candidate.services).filter((service) => service.role === "retained-dependency").length || prefix.nodes.some((node) => { const service = candidate.services[node.name]; return service?.role !== "retained-dependency" || managedServiceDigest(service) !== node.plan; }))) throw new Error("managed recovery service set disagrees");
  const nodes = Object.freeze(names.map((name) => {
    const target = candidate.services[name]; const previous = before?.services[name]; const selected = previous ?? target; if (selected === undefined) throw new Error("managed recovery service missing");
    const quiescence = stopped?.certificate.nodes.find((node) => node.name === name)?.child;
    const reference = prior.find((value) => value.name === name); const consumer = forward?.nodes.find((node) => node.name === name); const dependency = prefix?.nodes.find((node) => node.name === name);
    if (previous !== undefined && target?.role === "retained-dependency" || consumer !== undefined && consumer.target !== (target === undefined ? null : managedServiceDigest(target)) || dependency !== undefined && dependency.plan !== managedServiceDigest(selected)) throw new Error("managed recovery service role or digest disagrees");
    const versions = uniqueVersions([
      ...(reference === undefined ? [] : [reference.native]),
      ...(quiescence?.prior ?? []),
      ...(quiescence?.steps.flatMap((step) => step.expected === null ? Object.freeze([]) : Object.freeze([step.expected])) ?? []),
      ...(quiescence?.proof === undefined || quiescence.proof === null ? [] : [quiescence.proof.native]), ...(consumer?.baseline === null || consumer?.baseline === undefined ? [] : [consumer.baseline.native]),
      ...(consumer?.execution?.expected === null || consumer?.execution?.expected === undefined ? [] : [consumer.execution.expected]), ...(consumer?.execution?.verified === null || consumer?.execution?.verified === undefined ? [] : [consumer.execution.verified.native]),
      ...(consumer?.quiescence?.prior ?? []), ...(consumer?.quiescence?.steps.flatMap((step) => step.expected === null ? Object.freeze([]) : Object.freeze([step.expected])) ?? []), ...(consumer?.quiescence?.proof === null || consumer?.quiescence?.proof === undefined ? [] : [consumer.quiescence.proof.native]), ...(consumer?.ready === null || consumer?.ready === undefined ? [] : [consumer.ready.native]),
      ...(dependency?.baseline === null || dependency?.baseline === undefined ? [] : [dependency.baseline.native]), ...(dependency?.execution?.expected === null || dependency?.execution?.expected === undefined ? [] : [dependency.execution.expected]), ...(dependency?.execution?.verified === null || dependency?.execution?.verified === undefined ? [] : [dependency.execution.verified.native]), ...(dependency?.ready === null || dependency?.ready === undefined ? [] : [dependency.ready.native]),
    ]);
    // Reuse the executable child's identity/CAS validator before any parent recovery intent can be admitted.
    parseManagedServiceCompensation({ version: 1, action: { app: owner.app, incarnation: owner.incarnation, dataOwner: owner.dataOwner, service: name, action: origin.action, plan: managedServiceDigest(selected), effect: "restore", deadline: 2 }, createdAt: 1,
      candidate: plan, previous: previousDigest, baseline: reference?.native ?? null, prior: versions, fences: [], attempts: [], barrier: null, phase: "recovering", reason: null, proof: null });
    return Object.freeze({ name, plan: managedServiceDigest(selected), baseline: reference?.native ?? null, prior: versions });
  }));
  return Object.freeze({ version: 1 as const, app: owner.app, incarnation: owner.incarnation, dataOwner: owner.dataOwner, run: origin.run, action: origin.action, plan, previous: previousDigest, preparation: prefix === null ? null : hash(prefix), consumers: forward === null ? null : hash(forward), baselines: prior, retained, nodes, ...(checks === undefined ? {} : { checks }) });
};
export type ManagedRecoveryDescription = ReturnType<typeof describeManagedRecovery>;
export const managedRecoveryDigest = (description: ManagedRecoveryDescription) => hash(description);

/** Private immutable recovery input, revalidated whenever reopened from the artifact store. */
export const managedRecoverySnapshot = (input: unknown) => {
  const raw = z.object({ candidate: z.unknown(), previous: z.unknown().nullable(), preparation: z.unknown().nullable(), consumers: z.unknown().nullable(), baselines: references, maintenance: z.unknown().nullable().default(null), retained: references.default([]), checks: z.unknown().optional() }).strict().parse(input);
  const candidate = parseManagedApplicationPlan(raw.candidate); const previous = raw.previous === null ? null : parseManagedApplicationPlan(raw.previous);
  if (!candidate.ok || previous !== null && !previous.ok) throw new Error("invalid managed recovery snapshot plans");
  const preparation = raw.preparation === null ? null : parseManagedGroupPreparation(raw.preparation); const consumers = raw.consumers === null ? null : parseManagedConsumerState(raw.consumers);
  const baselines = Object.freeze(raw.baselines.map((ref) => { const action = parseManagedServiceAction(ref.action); if (!action.ok) throw new Error("invalid managed recovery snapshot baseline"); return Object.freeze({ ...ref, action: action.value }); }).toSorted((left, right) => left.name.localeCompare(right.name)));
  const retained = Object.freeze(raw.retained.map((value) => { const action = parseManagedServiceAction(value.action); if (!action.ok) throw new Error("invalid managed recovery retained action"); return Object.freeze({ ...value, action: action.value }); }).toSorted((a, b) => a.name.localeCompare(b.name)));
  const maintenance = raw.maintenance === null ? null : managedMaintenanceSnapshot(raw.maintenance);
  const checks = raw.checks === undefined ? undefined : managedCessationChecks(raw.checks, candidate.value, (preparation ?? maintenance?.certificate)?.action ?? "");
  const source = Object.freeze({ candidate: candidate.value, previous: previous === null ? null : previous.value, preparation, consumers, baselines, ...(maintenance === null ? {} : { maintenance }), ...(preparation === null || retained.length !== 0 ? { retained } : {}), ...(checks === undefined ? {} : { checks }) });
  return Object.freeze({ source, description: describeManagedRecovery(source.candidate, source.previous, preparation, consumers, baselines, maintenance, retained, checks) });
};
