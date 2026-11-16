import { createHash } from "node:crypto";
import type { ManagedChecksPort } from "../../contracts/container-check.ts";
import { z } from "zod";
import { managedApplicationDigest, managedMigrationDescription, managedMigrationSeconds, parseManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { ManagedServiceAction, ManagedServiceScope } from "../../contracts/managed-swarm-service.ts";
import type { JobPlan, JobPort, JobWrite } from "../../contracts/one-shot-job.ts";
import type { ServiceObservation, ServiceVersion } from "../../contracts/swarm-service.ts";
import { migrationSequenceDigest } from "../../contracts/migration-sequence.ts";
import { migrationSequence, parseMigrationSequenceState } from "./migration-sequence.ts";
import type { JobExecution } from "./one-shot-execution.ts";
import { managedServiceExecution, parseManagedServiceExecution } from "./managed-service-execution.ts";
import { managedMaintenanceSnapshot } from "./managed-maintenance-quiescence.ts";
import { convergedService, clearedService } from "./service-convergence.ts";
import { claimJournal } from "./journal-claim.ts";
import type { OperationJournal } from "./operation.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: positive }).strict().readonly();
const baseline = z.object({ kind: z.enum(["active", "barrier"]), action: z.unknown(), native: version }).strict().readonly();
const legacySchema = z.object({ version: z.literal(1), app: z.string().max(48), incarnation: z.uuid(), dataOwner: z.uuid(), run: z.uuid(), action: z.string().max(80), plan: digest,
  createdAt: positive, startupDeadline: positive, migrationDeadline: positive, consumerDeadline: positive.nullable(), sequencePlan: digest.nullable(),
  phase: z.enum(["dependencies", "migrating", "ready", "held"]), reason: z.enum(["deadline", "dependency", "migration"]).nullable(),
  nodes: z.array(z.object({ name: z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), plan: digest, baseline: baseline.nullable(), execution: z.unknown().nullable(),
    ready: z.object({ action: z.unknown(), native: version, at: positive }).strict().readonly().nullable(),
  }).strict().readonly()).max(32).readonly(), sequence: z.unknown().nullable(),
}).strict().readonly();
const schema = z.union([legacySchema, legacySchema.unwrap().extend({ version: z.literal(2), maintenance: digest }).strict().readonly()]);
export type RetainedBaseline = { readonly name: string; readonly kind: "active" | "barrier"; readonly action: ManagedServiceAction; readonly native: ServiceVersion };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export const parseManagedGroupPreparation = (input: unknown) => {
  const checked = schema.safeParse(input); if (!checked.success) throw new Error("invalid managed group preparation");
  const state = checked.data;
  const nodes = Object.freeze(state.nodes.map((node) => {
    const prior = node.baseline === null ? null : parseManagedServiceAction(node.baseline.action);
    const ready = node.ready === null ? null : parseManagedServiceAction(node.ready.action);
    const execution = node.execution === null ? null : parseManagedServiceExecution(node.execution);
    if (prior !== null && (!prior.ok || prior.value.plan !== node.plan || prior.value.app !== state.app || prior.value.incarnation !== state.incarnation || prior.value.dataOwner !== state.dataOwner || prior.value.service !== node.name || Number(prior.value.action.split(":")[1]) >= Number(state.action.split(":")[1]) ||
      (node.baseline?.kind === "barrier" ? prior.value.effect !== "scrub" : prior.value.effect !== "apply" && prior.value.effect !== "restore")) ||
      ready !== null && (!ready.ok || ready.value.plan !== node.plan || ready.value.app !== state.app || ready.value.incarnation !== state.incarnation || ready.value.dataOwner !== state.dataOwner || ready.value.service !== node.name || node.ready === null || node.ready.at < state.createdAt || node.ready.at >= state.startupDeadline) ||
      execution !== null && (execution.action.plan !== node.plan || execution.action.app !== state.app || execution.action.incarnation !== state.incarnation || execution.action.dataOwner !== state.dataOwner || execution.action.service !== node.name || execution.action.action !== state.action || execution.action.deadline !== state.startupDeadline ||
        (node.baseline?.kind === "barrier" ? execution.mode !== "reactivate-retained" : execution.mode !== "apply" || node.baseline !== null))) throw new Error("managed dependency evidence disagrees");
    if (node.ready !== null && ready?.ok && (execution === null ? node.baseline?.kind !== "active" || !prior?.ok || !same(ready.value, prior.value) || node.ready.native.id !== node.baseline.native.id || node.ready.native.version < node.baseline.native.version :
      execution.phase !== "converged" || execution.verified === null || !same(ready.value, execution.action) || !same(node.ready.native, execution.verified.native) || node.ready.at < execution.verified.at)) throw new Error("managed dependency readiness lacks its execution proof");
    return Object.freeze({ ...node, baseline: node.baseline === null || !prior?.ok ? null : Object.freeze({ ...node.baseline, action: prior.value }),
      ready: node.ready === null || !ready?.ok ? null : Object.freeze({ ...node.ready, action: ready.value }), execution });
  }));
  const sequence = state.sequence === null ? null : parseMigrationSequenceState(state.sequence);
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(state.app) || state.incarnation === state.dataOwner || !new RegExp(`^${state.incarnation}:[1-9][0-9]*$`).test(state.action) || !Number.isSafeInteger(Number(state.action.split(":")[1])) ||
    state.startupDeadline !== state.createdAt + 90_000 || state.migrationDeadline < state.startupDeadline + 90_000 || new Set(nodes.map((node) => node.name)).size !== nodes.length ||
    (state.phase === "held") !== (state.reason !== null) || (state.phase === "ready") !== (state.consumerDeadline !== null) ||
    state.consumerDeadline !== null && (state.consumerDeadline <= state.createdAt || state.consumerDeadline > state.migrationDeadline + 90_000) ||
    state.phase !== "dependencies" && state.phase !== "held" && nodes.some((node) => node.ready === null) ||
    sequence !== null && (sequence.plan !== state.sequencePlan || sequence.scope.app !== state.app || sequence.scope.incarnation !== state.incarnation || sequence.scope.run !== state.run || sequence.createdAt < state.createdAt || nodes.some((node) => node.ready === null) || sequence.deadline !== state.migrationDeadline) ||
    state.phase === "dependencies" && sequence !== null || state.phase === "migrating" && state.sequencePlan === null ||
    state.phase === "ready" && state.sequencePlan !== null && (sequence?.phase !== "succeeded" || sequence.completedAt !== null && state.consumerDeadline !== null && sequence.completedAt > state.consumerDeadline - 90_000)) throw new Error("inconsistent managed group preparation");
  return Object.freeze({ ...state, nodes, sequence });
};
export type ManagedGroupPreparation = ReturnType<typeof parseManagedGroupPreparation>;
type ServiceRuntime = Parameters<typeof managedServiceExecution>[1]["runtime"] & { readonly observe: (scope: ManagedServiceScope) => Promise<ServiceObservation> };
type Ports = {
  readonly checks?: ManagedChecksPort | undefined;
  readonly now: () => number; readonly read: (digest: string) => Promise<string>; readonly retain: (bytes: string) => Promise<string>;
  readonly services: ServiceRuntime;
  /** Composition resolves checked input references inside Create; no materialized job environment enters this parent. */
  readonly jobs: Readonly<Pick<JobPort, "observe" | "start" | "fence">> & { readonly create: (job: JobPlan) => Promise<JobWrite> };
  readonly authorize: (state: ManagedGroupPreparation, effect: { readonly kind: "service"; readonly action: ManagedServiceAction } | { readonly kind: "migration"; readonly job: JobExecution; readonly effect: "create" | "start" | "fence" }) => Promise<boolean>;
};

/** Private rolling preparation phase under the lifecycle writer. Does not admit, quiesce consumers or promote a release. */
export const managedGroupPreparation = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "managed group preparation already has an owner");
  // eslint-disable-next-line functional/no-let -- serializes the parent and all private child views
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- uncertain synchronization requires reopen
  let poisoned = false;
  const serial = <T>(call: () => Promise<T>) => { const result = pending.then(() => { if (poisoned) throw new Error("managed preparation write is uncertain; reopen and reconcile"); return call(); }); pending = result.then(() => undefined, () => undefined); return result; };
  const children = new Map<string, ReturnType<typeof managedServiceExecution>>();
  const load = async () => { const value = await journal.read(); return value === undefined ? undefined : parseManagedGroupPreparation(value); };
  const required = async () => { const state = await load(); if (state === undefined) throw new Error("managed group preparation is missing"); return state; };
  const write = async (value: ManagedGroupPreparation) => { const state = parseManagedGroupPreparation(value); try { await journal.write(state); } catch { poisoned = true; throw new Error("managed preparation write is uncertain; reopen and reconcile"); } return state; };
  const time = (minimum = 1) => { const now = ports.now(); if (!Number.isSafeInteger(now) || now < minimum) throw new Error("managed group clock is unavailable"); return now; };
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => {
    const remaining = deadline - time(); if (remaining <= 0) return undefined;
    const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, remaining);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); } finally { clearTimeout(timer); }
  };
  const maintenanceSource = async (state: ManagedGroupPreparation) => {
    if (state.version === 1) return null;
    const bytes = await bounded(time() + 10_000, () => ports.read(state.maintenance)); if (bytes === undefined) throw new Error("maintenance preparation source unavailable");
    const raw: unknown = JSON.parse(bytes); const snapshot = managedMaintenanceSnapshot(raw);
    if (snapshot.certificate.phase !== "complete" || snapshot.certificate.plan !== state.plan || snapshot.certificate.run !== state.run || snapshot.certificate.action !== state.action || snapshot.certificate.verifiedAt !== state.createdAt || bytes !== JSON.stringify(snapshot)) throw new Error("maintenance preparation source disagrees");
    if (createHash("sha256").update(bytes).digest("hex") !== state.maintenance) throw new Error("maintenance preparation source digest disagrees");
    return snapshot;
  };
  const quiescent = async (state: ManagedGroupPreparation) => {
    const snapshot = await maintenanceSource(state); if (snapshot === null) return true;
    for (const node of snapshot.certificate.nodes) {
      const observed = await bounded(time() + 10_000, () => ports.services.observe({ app: state.app, service: node.name, incarnation: state.incarnation, dataOwner: state.dataOwner }));
      const proof = node.child?.proof; const latest = node.child?.steps.at(-1);
      if (observed?.status !== "owned" || proof === null || proof === undefined || !clearedService(observed) || observed.id !== proof.native.id || observed.version < proof.native.version || latest?.effect !== "scrub" || observed.action !== state.action + ":quiesce:scrub:" + String(latest.attempt) || observed.effect !== "scrub" || observed.plan !== node.plan) return false;
    }
    return true;
  };
  const description = async (state: ManagedGroupPreparation) => {
    const bytes = await bounded(time() + 10_000, () => ports.read(state.plan)); if (bytes === undefined) throw new Error("managed preparation plan is unavailable"); const raw: unknown = JSON.parse(bytes); const checked = parseManagedApplicationPlan(raw);
    if (!checked.ok || bytes !== JSON.stringify(checked.value) || managedApplicationDigest(checked.value) !== state.plan || checked.value.infrastructure.ownership.app !== state.app || checked.value.infrastructure.ownership.incarnation !== state.incarnation || checked.value.infrastructure.ownership.dataOwner !== state.dataOwner ||
      state.migrationDeadline !== state.startupDeadline + Math.max(90, managedMigrationSeconds(checked.value)) * 1000 ||
      state.nodes.length !== Object.values(checked.value.services).filter((service) => service.role === "retained-dependency").length || state.nodes.some((node) => { const service = checked.value.services[node.name]; return service?.role !== "retained-dependency" || managedServiceDigest(service) !== node.plan; })) throw new Error("managed preparation plan integrity failed");
    if (checked.value.rollout.strategy === "maintenance" ? state.version !== 2 : state.version !== 1) throw new Error("managed preparation strategy evidence disagrees");
    await maintenanceSource(state);
    const source = checked.value.rollout.migrations.length === 0 ? null : managedMigrationDescription(checked.value, state.run);
    if (source !== null && !source.ok || state.sequencePlan !== (!source?.ok ? null : migrationSequenceDigest(source.value))) throw new Error("managed migration binding changed");
    return checked.value;
  };
  const healthy = async (state: ManagedGroupPreparation, plan: ManagedApplicationPlan, names: readonly string[] = state.nodes.map((node) => node.name)) => {
    const observations = await bounded(time() + 10_000, async () => Object.freeze(await Promise.all(names.map(async (name) => {
      const node = state.nodes.find((item) => item.name === name); const service = plan.services[name];
      return node?.ready === null || node?.ready === undefined || service === undefined ? false : convergedService(node.ready.action, await ports.services.observeDesired(node.ready.action, service));
    }))));
    return observations?.every(Boolean) === true;
  };
  const child = (name: string) => {
    const previous = children.get(name); if (previous !== undefined) return previous;
    const view = { read: async () => (await required()).nodes.find((node) => node.name === name)?.execution ?? undefined,
      write: async (value: unknown) => { const state = await required(); if (state.phase !== "dependencies") throw new Error("dependency slot lost parent ownership"); const execution = parseManagedServiceExecution(value); await write({ ...state, nodes: state.nodes.map((node) => node.name === name ? { ...node, execution } : node) }); },
    };
    const owner = managedServiceExecution(view, { ...ports, runtime: ports.services, authorize: async (execution) => {
      const state = await required(); const node = state.nodes.find((node) => node.name === name);
      const plan = await description(state); const service = plan.services[name];
      return state.phase === "dependencies" && same(node?.execution, execution) && service !== undefined && await quiescent(state) && await healthy(state, plan, service.dependencies.map((dependency) => dependency.service)) && ports.authorize(state, { kind: "service", action: execution.action });
    } });
    // eslint-disable-next-line functional/immutable-data -- one private child owner per retained service
    children.set(name, owner); return owner;
  };
  const migrations = migrationSequence({ read: async () => (await required()).sequence ?? undefined, write: async (value: unknown) => {
    const state = await required(); if (state.phase !== "migrating") throw new Error("migration sequence lost parent ownership"); await write({ ...state, sequence: parseMigrationSequenceState(value) });
  } }, { ...ports, native: ports.jobs, materialize: () => Promise.resolve(Object.freeze({})), authorize: async (_sequence, _source, job, effect) => {
    const state = await required(); const plan = await description(state);
    return state.phase === "migrating" && (effect === "fence" || await quiescent(state) && await healthy(state, plan)) && ports.authorize(state, { kind: "migration", job, effect });
  } });
  const hold = (state: ManagedGroupPreparation, reason: "deadline" | "dependency" | "migration") => write({ ...state, phase: "held", consumerDeadline: null, reason });
  return Object.freeze({
    prepare: (input: ManagedApplicationPlan, run: string, action: string, baselines: readonly RetainedBaseline[], maintenance?: unknown) => {
      const checked = parseManagedApplicationPlan(input); if (!checked.ok) return Promise.reject(new Error("invalid managed preparation plan"));
      const records = z.array(z.object({ name: z.string().max(48), kind: z.enum(["active", "barrier"]), action: z.unknown(), native: version }).strict().readonly()).max(32).readonly().safeParse(baselines);
      if (!records.success) return Promise.reject(new Error("invalid managed retained baseline references"));
      const references = Object.freeze(records.data.map((value) => { const parsed = parseManagedServiceAction(value.action); if (!parsed.ok) throw new Error("invalid managed retained action reference"); return Object.freeze({ ...value, action: parsed.value }); }));
      const plan = checked.value; const proof = maintenance === undefined ? null : managedMaintenanceSnapshot(maintenance);
      if (plan.rollout.strategy === "maintenance" ? proof?.certificate.phase !== "complete" || proof.certificate.plan !== managedApplicationDigest(plan) || proof.certificate.run !== run || proof.certificate.action !== action : proof !== null) return Promise.reject(new Error("managed preparation maintenance capabilities require matching quiescence evidence"));
      return serial(async () => {
        if (references.some((reference) => reference.kind === "barrier") && ports.services.reactivate === undefined) throw new Error("retained reactivation capability is unavailable");
        if (ports.checks === undefined && (plan.rollout.checks.length !== 0 || Object.values(plan.services).some((service) => service.overlap === "coordinated"))) throw new Error("managed preparation capabilities are not available for maintenance or coordinated checks");
        const nodes = Object.values(plan.services).filter((service) => service.role === "retained-dependency").map((service) => {
          const prior = references.find((value) => value.name === service.service); return Object.freeze({ name: service.service, plan: managedServiceDigest(service), baseline: prior === undefined ? null : Object.freeze({ kind: prior.kind, action: prior.action, native: prior.native }), execution: null, ready: null });
        });
        if (references.length > 32 || new Set(references.map((item) => item.name)).size !== references.length || references.some((item) => !nodes.some((node) => node.name === item.name))) throw new Error("managed retained baselines disagree");
        const existing = await load(); if (existing !== undefined) { if ((existing.version === 1 ? proof !== null : proof === null || existing.maintenance !== createHash("sha256").update(JSON.stringify(proof)).digest("hex")) || existing.plan !== managedApplicationDigest(plan) || existing.run !== run || existing.action !== action || !same(existing.nodes.map((node) => Object.freeze({ name: node.name, baseline: node.baseline })), nodes.map((node) => Object.freeze({ name: node.name, baseline: node.baseline })))) throw new Error("managed preparation intent conflicts"); await description(existing); return existing; }
        const now = proof?.certificate.verifiedAt ?? time(); if (time() < now || time() >= now + 90_000) throw new Error("managed preparation scheduling deadline expired"); const source = plan.rollout.migrations.length === 0 ? null : managedMigrationDescription(plan, run); if (source !== null && !source.ok) throw new Error(source.error);
        const state = parseManagedGroupPreparation({ ...plan.infrastructure.ownership, ...(proof === null ? { version: 1 } : { version: 2, maintenance: createHash("sha256").update(JSON.stringify(proof)).digest("hex") }), run, action, plan: managedApplicationDigest(plan), createdAt: now, startupDeadline: now + 90_000,
          migrationDeadline: now + (90 + Math.max(90, managedMigrationSeconds(plan))) * 1000, consumerDeadline: null, sequencePlan: source === null ? null : migrationSequenceDigest(source.value), phase: "dependencies", reason: null, nodes, sequence: null });
        if (state.version === 2 && await bounded(state.startupDeadline, () => ports.retain(JSON.stringify(proof))) !== state.maintenance || await bounded(state.startupDeadline, () => ports.retain(JSON.stringify(plan))) !== state.plan || source !== null && await bounded(state.startupDeadline, () => ports.retain(JSON.stringify(source.value))) !== state.sequencePlan) throw new Error("managed preparation artifact retention failed"); if (time(state.createdAt) >= state.startupDeadline) throw new Error("managed preparation deadline expired before intent"); return write(state);
      });
    },
    read: () => serial(load),
    tick: () => serial(async () => {
      const state = await required(); const plan = await description(state); const now = time(state.createdAt);
      if (state.phase === "ready" || state.phase === "held") return state;
      if (state.phase === "dependencies") {
        if (now >= state.startupDeadline) return hold(state, "deadline");
        const node = state.nodes.find((node) => node.ready === null && plan.services[node.name]?.dependencies.every((dependency) => state.nodes.some((other) => other.name === dependency.service && other.ready !== null)));
        if (node !== undefined) {
          const service = plan.services[node.name]; if (service === undefined) throw new Error("managed retained specification is missing");
          if (node.execution !== null) {
            const current = await child(node.name).tick(); if (current.phase === "held") return hold(await required(), "dependency");
            const verified = current.verified;
            if (current.phase === "converged" && verified !== null) { const after = await required(); return write({ ...after, nodes: after.nodes.map((item) => item.name === node.name ? { ...item, ready: { action: current.action, native: verified.native, at: time(state.createdAt) } } : item) }); }
            return required();
          }
          const observed = await bounded(time() + 10_000, () => ports.services.observe({ app: state.app, service: node.name, incarnation: state.incarnation, dataOwner: state.dataOwner }));
          if (observed === undefined || observed.status === "unavailable") return state;
          const previous = node.baseline;
          if (previous?.kind === "active") {
            const desired = await bounded(time() + 10_000, () => ports.services.observeDesired(previous.action, service));
            if (desired === undefined || desired.status === "unavailable") return state;
            if (desired.status !== "owned" || desired.id !== previous.native.id || desired.version < previous.native.version) return hold(state, "dependency");
            return convergedService(previous.action, desired) ? write({ ...state, nodes: state.nodes.map((item) => item.name === node.name ? { ...item, ready: { action: previous.action, native: { id: desired.id, version: desired.version }, at: time(state.createdAt) } } : item) }) : state;
          }
          if (previous === null && observed.status !== "absent" || previous !== null && (observed.status !== "owned" || observed.id !== previous.native.id || observed.version < previous.native.version || observed.action !== previous.action.action || observed.plan !== node.plan || !observed.tombstone || !observed.retainedInputsCleared)) return hold(state, "dependency");
          if (previous?.kind === "barrier" && observed.status === "owned" && (observed.replicas !== 0 || observed.endpoint !== "dnsrr" || ![null, "completed", "rollback_completed"].includes(observed.update) || observed.tasks.some((task) => !["shutdown", "complete", "failed", "rejected", "remove", "orphaned"].includes(task.state)))) return state;
          const expected = observed.status === "owned" ? { id: observed.id, version: observed.version } : null;
          await child(node.name).prepare(service, { app: state.app, service: node.name, incarnation: state.incarnation, dataOwner: state.dataOwner, action: state.action, plan: node.plan, deadline: state.startupDeadline, effect: "apply" }, expected, previous === null ? "apply" : "reactivate-retained"); return required();
        }
        if (state.nodes.some((node) => node.ready === null) || !await healthy(state, plan)) return state;
        if (time(state.createdAt) >= state.startupDeadline) return hold(state, "deadline");
        if (!await quiescent(state)) return hold(state, "dependency");
        if (state.sequencePlan === null) return write({ ...state, phase: "ready", consumerDeadline: time(state.createdAt) + 90_000 });
        return write({ ...state, phase: "migrating" });
      }
      if (state.sequence === null) {
        if (now >= state.migrationDeadline) return hold(state, "deadline");
        const source = managedMigrationDescription(plan, state.run); if (!source.ok) throw new Error(source.error); await migrations.prepare(source.value, state.migrationDeadline); return required();
      }
      if (state.sequence.phase === "held") return hold(state, "migration");
      if (state.sequence.phase !== "succeeded") { await migrations.tick(); return required(); }
      if (now >= state.migrationDeadline) return hold(state, "deadline");
      if (!await healthy(state, plan)) return state;
      if (!await quiescent(state)) return hold(state, "dependency");
      const finished = time(state.createdAt); return finished >= state.migrationDeadline ? hold(state, "deadline") : write({ ...state, phase: "ready", consumerDeadline: finished + 90_000 });
    }),
  });
};
