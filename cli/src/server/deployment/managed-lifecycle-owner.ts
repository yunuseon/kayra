import type { DataOwnership } from "../../contracts/owned-volume.ts";
import type { ManagedAdmissionPort, ManagedAdmissionIdentity } from "../../contracts/managed-admission.ts";
import { parseManagedAdmissionIdentity } from "../../contracts/managed-admission.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import type { ManagedRoutedReadinessPort } from "../../contracts/routed-readiness.ts";
import type { ManagedChecksPort } from "../../contracts/container-check.ts";
import type { ManagedServicePlan } from "../../contracts/managed-service-plan.ts";
import type { ServiceVersion } from "../../contracts/swarm-service.ts";
import type { ManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { JobExecution } from "./one-shot-execution.ts";
import type { MigrationResolutionActor, MigrationResolutionRequest } from "../../contracts/migration-resolution.ts";
import { parseMigrationResolutionRequest, parseMigrationResolutionActor } from "../../contracts/migration-resolution.ts";
import { managedLifecycleStore } from "./managed-lifecycle-store.ts";
import type { ManagedLifecycleStore } from "./managed-lifecycle-store.ts";
import { parseManagedLifecycleSource, managedLifecycleDescription } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import { managedGroupPreparation } from "./managed-group-preparation.ts";
import { managedMaintenanceQuiescence } from "./managed-maintenance-quiescence.ts";
import { managedConsumerRollout } from "./managed-consumer-rollout.ts";
import { managedVerificationSnapshot } from "./managed-verification-source.ts";
import { managedGroupVerification } from "./managed-group-verification.ts";
import type { OperationJournal } from "./operation.ts";
import { createHash } from "node:crypto";
import { managedGroupCompensation } from "./managed-group-compensation.ts";
import { managedRollingRecoverySource, verifyManagedRecoveryJobs } from "./managed-recovery-safety.ts";

export type ManagedLifecycleEffect = { readonly kind: "admission" | "verify" | "recovery" } | { readonly kind: "service"; readonly action: ManagedServiceAction } |
  { readonly kind: "migration"; readonly job: JobExecution; readonly effect: "create" | "start" | "fence" } |
  { readonly kind: "check"; readonly check: string; readonly effect: "create" | "start" } |
  { readonly kind: "migration-resolution"; readonly request: MigrationResolutionRequest; readonly actor: MigrationResolutionActor };
type Ports = { readonly now: () => number; readonly read: (digest: string) => Promise<string>; readonly retain: (bytes: string) => Promise<string>;
  readonly admission: ManagedAdmissionPort; readonly services: ManagedWorkloadPort; readonly jobs: Parameters<typeof managedGroupPreparation>[1]["jobs"];
  readonly readiness: ManagedRoutedReadinessPort; readonly checks?: ManagedChecksPort | undefined;
  /** Composition verifies registration/protocol, current operator grants and source identities without teaching the owner fleet or forge semantics. */
  readonly authorize: (source: ManagedLifecycleSource, effect: ManagedLifecycleEffect) => Promise<boolean>;
};

/** Private lifecycle owner. Unresolved/unsafe work keeps its charge. Not an ordinary deployment entrypoint. */
export const managedLifecycleOwner = (journal: OperationJournal, owner: DataOwnership, ports: Ports) => {
  const store = managedLifecycleStore(journal, owner, ports);
  // eslint-disable-next-line functional/no-let -- duplicate observer ticks share one flight; filesystem commands remain independently serialized
  let flight: Promise<ManagedLifecycleStore | undefined> | undefined;
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => { const left = Math.min(10_000, deadline - ports.now()); if (left <= 0 || !Number.isFinite(left)) return undefined; const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, left);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); } finally { clearTimeout(timer); }
  };
  const identity = (state: ManagedLifecycleStore) => { const checked = parseManagedAdmissionIdentity({ owner: state.owner, run: state.operation.run, action: state.operation.action, source: state.operation.source, plan: state.operation.plan, deadline: state.operation.admissionDeadline }); if (!checked.ok) throw new Error(checked.error); return checked.value; };
  const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  const recoverySource = async (state: ManagedLifecycleStore) => { const digest = state.operation.recoverySource; if (digest === null) throw new Error("managed recovery source missing"); const bytes = await bounded(state.operation.deadline, () => ports.read(digest)); if (bytes === undefined || hash(bytes) !== digest) throw new Error("managed recovery source unavailable"); const raw: unknown = JSON.parse(bytes); return raw; };
  const allowed = async (run: string, phase: ManagedLifecycleStore["operation"]["phase"], effect: ManagedLifecycleEffect) => {
    const current = await store.read(); if (current?.operation.run !== run || current.operation.phase !== phase || current.operation.cancelRequestedAt !== null || !current.operation.admitted || ports.now() >= current.operation.deadline) return false;
    const source = await store.source(); const claim = managedLifecycleDescription(source).admission;
    if (await bounded(current.operation.deadline, () => ports.admission.observe(identity(current), claim)) !== "reserved" || await bounded(current.operation.deadline, () => ports.authorize(source, effect)) !== true) return false;
    const startsApplication = effect.kind === "service" && ["apply", "restore"].includes(effect.action.effect) || effect.kind === "migration" && effect.effect === "start" || effect.kind === "check" && effect.effect === "start";
    return !startsApplication || store.fenceCompatibility(run, phase);
  };
  const allowedRecovery = async (run: string, phase: "recovering" | "recovery-verifying", effect: ManagedLifecycleEffect) => {
    const current = await store.read(); if (current?.operation.run !== run || current.operation.phase !== phase || current.operation.preparation === null || !current.operation.admitted || current.active?.epoch !== current.compatibilityEpoch || ports.now() >= current.operation.deadline) return false;
    const source = await store.source(); const prefix = current.operation.preparation;
    return await bounded(current.operation.deadline, () => ports.admission.observe(identity(current), managedLifecycleDescription(source).admission)) === "reserved" &&
      await bounded(current.operation.deadline, async () => { await verifyManagedRecoveryJobs(source, prefix, { read: ports.read, native: ports.jobs }); return true; }) === true && await bounded(current.operation.deadline, () => ports.authorize(source, effect)) === true;
  };
  const components = new Map<string, { readonly quiescence: ReturnType<typeof managedMaintenanceQuiescence>; readonly preparation: ReturnType<typeof managedGroupPreparation>; readonly consumers: ReturnType<typeof managedConsumerRollout>; readonly verification: ReturnType<typeof managedGroupVerification>; readonly recovery: ReturnType<typeof managedGroupCompensation>; readonly recoveryVerification: ReturnType<typeof managedGroupVerification> }>();
  const forRun = (source: ManagedLifecycleSource) => {
    const cached = components.get(source.run); if (cached !== undefined) return cached;
    const preparation = managedGroupPreparation(store.child("preparation", source.run), { ...ports, services: {
      observe: ports.services.observe,
      ...(ports.services.reactivate === undefined ? {} : { reactivate: (action: ManagedServiceAction, expected: ServiceVersion, spec: ManagedServicePlan) => { const call = ports.services.reactivate; if (call === undefined) return Promise.resolve("refused" as const); return call(action, expected, spec, source.candidate); } }),
      observeDesired: (action, spec) => ports.services.observeDesired(action, spec, source.candidate),
      apply: (action, expected, spec) => ports.services.apply(action, expected, spec, source.candidate),
    }, authorize: (_, effect) => allowed(source.run, "preparing", effect) });
    const quiescence = managedMaintenanceQuiescence(store.child("quiescence", source.run), { ...ports, authorize: (_, action) => allowed(source.run, "quiescing", action === null ? { kind: "verify" } : { kind: "service", action }) });
    const consumers = managedConsumerRollout(store.child("consumers", source.run), { ...ports, authorize: (_, effect) => allowed(source.run, "updating", effect) });
    const verification = managedGroupVerification(store.child("verification", source.run), { ...ports, authorize: (_, effect) => allowed(source.run, "verifying", effect) });
    const recovery = managedGroupCompensation(store.child("recovery", source.run), { ...ports, authorize: (_, effect) => allowedRecovery(source.run, "recovering", effect) });
    const recoveryVerification = managedGroupVerification(store.child("recoveryVerification", source.run), { ...ports, authorize: (_, effect) => allowedRecovery(source.run, "recovery-verifying", effect) });
    const value = Object.freeze({ preparation, quiescence, consumers, verification, recovery, recoveryVerification });
    // eslint-disable-next-line functional/immutable-data -- one component set per operation, never reused with a different app context
    components.set(source.run, value); return value;
  };
  const tick = async () => {
    const current = await store.read(); if (current === undefined || current.operation.phase === "complete") return current;
    const source = await store.source(); const description = managedLifecycleDescription(source); const lease: ManagedAdmissionIdentity = identity(current); const phase = current.operation.phase;
    if (phase === "settling") {
      const result = current.operation.settlement; if (result === null) throw new Error("managed lifecycle settlement outcome missing");
      const observed = await bounded(ports.now() + 10_000, () => ports.admission.observe(lease, description.admission));
      if (observed === `settled-${result}`) return store.settle();
      if (observed !== "reserved") return current;
      if (await bounded(ports.now() + 10_000, () => ports.admission.settle(lease, description.admission, result)) === "settled") return store.settle(); return store.read();
    }
    if (phase === "held") {
      if (current.operation.recoverySource !== null || ports.services.fence === undefined) return current;
      const at = ports.now(); try { managedRollingRecoverySource(current, source, at); } catch { return current; }
      const prefix = current.operation.preparation; if (prefix === null) return current;
      if (await bounded(current.operation.deadline, () => ports.admission.observe(lease, description.admission)) !== "reserved" || await bounded(current.operation.deadline, async () => { await verifyManagedRecoveryJobs(source, prefix, { read: ports.read, native: ports.jobs }); return true; }) !== true || await bounded(current.operation.deadline, () => ports.authorize(source, { kind: "recovery" })) !== true) return current;
      return store.beginRecovery(hash(JSON.stringify(current.operation)), at);
    }
    if (ports.now() >= (phase === "admitting" ? current.operation.admissionDeadline : current.operation.deadline)) return store.hold("deadline");
    if (phase === "admitting") {
      const observed = await bounded(current.operation.admissionDeadline, () => ports.admission.observe(lease, description.admission));
      if (observed === "reserved") return store.admit();
      if (observed === "foreign" || observed?.startsWith("settled-")) return store.hold("admission");
      if (observed !== "absent") return current;
      if (await bounded(current.operation.admissionDeadline, () => ports.authorize(source, { kind: "admission" })) !== true) return store.hold("authorization");
      const result = await bounded(current.operation.admissionDeadline, () => ports.admission.reserve(lease, description.admission)); return result === "refused" ? store.hold("admission") : store.read();
    }
    const child = forRun(source);
    if (phase === "recovering") {
      if (current.operation.recovery === null) { if (current.operation.recoveryStartedAt === null || ports.now() >= (current.operation.recoveryDeadline ?? 0)) return store.hold("deadline"); await child.recovery.prepare(await recoverySource(current), current.operation.recoveryStartedAt); return store.read(); }
      const result = await child.recovery.tick(); return result.phase === "verified" ? store.verifyRecovery() : result.phase === "held" ? store.hold("recovery") : store.read();
    }
    if (phase === "recovery-verifying") {
      if (current.operation.recoveryVerification === null) { const snapshot = { kind: "recovery", application: source.previous?.source.application, certificate: current.operation.recovery, recoverySource: await recoverySource(current) }; if (ports.now() >= managedVerificationSnapshot(snapshot).deadline) return store.hold("deadline"); await child.recoveryVerification.prepare(snapshot); return store.read(); }
      const result = await child.recoveryVerification.tick(); return result.phase === "held" ? store.hold("recovery-verification") : store.read();
    }
    if (phase === "quiescing") {
      if (current.operation.quiescence === null && ports.now() >= current.operation.enteredAt + 90_000) return store.hold("deadline");
      if (current.operation.quiescence === null) { await child.quiescence.prepare({ candidate: source.candidate, previous: description.admission.previous, baselines: description.baselines.map((value) => Object.freeze({ ...value, prior: Object.freeze([]) })), run: source.run, action: source.action, startedAt: current.operation.enteredAt }); return store.read(); }
      const result = await child.quiescence.tick(); return result.phase === "complete" && result.verifiedAt !== null ? store.enter("quiescing", "preparing", result.verifiedAt) : result.phase === "held" ? store.hold("quiescence") : store.read();
    }
    if (phase === "preparing") {
      if (current.operation.preparation === null) {
        if (ports.now() >= current.operation.enteredAt + 90_000) return store.hold("deadline");
        const bytes = current.operation.quiescence === null ? undefined : await bounded(ports.now() + 10_000, () => ports.read(current.operation.quiescence?.source ?? ""));
        if (current.operation.quiescence !== null && bytes === undefined) return store.hold("quiescence");
        const raw: unknown = bytes === undefined ? undefined : JSON.parse(bytes);
        const proof = current.operation.quiescence === null ? undefined : { certificate: current.operation.quiescence, source: raw };
        await child.preparation.prepare(source.candidate, source.run, source.action, source.retained, proof, current.operation.enteredAt); return store.read();
      }
      const result = await child.preparation.tick(); return result.phase === "ready" && result.consumerDeadline !== null ? store.enter("preparing", "updating", result.consumerDeadline - 90_000) : result.phase === "held" ? store.hold("preparation") : store.read();
    }
    if (phase === "updating") {
      if (current.operation.consumers === null) { if (ports.now() >= (current.operation.preparation?.consumerDeadline ?? 0)) return store.hold("deadline"); if (current.operation.preparation === null) throw new Error("managed lifecycle preparation missing"); await child.consumers.prepare(source.candidate, current.operation.preparation, description.admission.previous, description.baselines); return store.read(); }
      const result = await child.consumers.tick(); return result.phase === "ready" && result.verifiedAt !== null ? store.enter("updating", "verifying", result.verifiedAt) : result.phase === "held" ? store.hold("consumers") : store.read();
    }
    if (current.operation.verification === null) { if (current.operation.consumers === null) throw new Error("managed lifecycle consumers missing"); if (ports.now() >= managedVerificationSnapshot({ kind: "deployment", application: source.candidate, certificate: current.operation.consumers }).deadline) return store.hold("deadline"); await child.verification.prepare({ kind: "deployment", application: source.candidate, certificate: current.operation.consumers }); return store.read(); }
    const result = await child.verification.tick(); return result.phase === "held" ? store.hold("verification") : store.read();
  };
  return Object.freeze({
    read: store.read, source: store.source,
    begin: async (input: ManagedLifecycleSource) => { const source = parseManagedLifecycleSource(input);
      const existing = await store.read(); if (existing?.operation.run === source.run) return store.begin(source);
      if (source.previous !== null && source.candidate.rollout.strategy === "rolling" && ports.services.fence === undefined) throw new Error("managed rolling recovery fencing capability unavailable");
      if (source.retained.some((value) => value.kind === "barrier") && ports.services.reactivate === undefined || ports.checks === undefined && [source.candidate, ...(source.previous === null ? [] : [source.previous.source.application])].some((plan) => plan.rollout.checks.length > 0 || Object.values(plan.services).some((service) => service.overlap === "coordinated"))) throw new Error("managed lifecycle capabilities unavailable");
      if (await bounded(source.createdAt + 90_000, () => ports.authorize(source, { kind: "admission" })) !== true) throw new Error("managed lifecycle source is not authorized"); return store.begin(source); },
    cancel: store.cancel,
    resolveMigration: async (request: MigrationResolutionRequest, actor: MigrationResolutionActor) => {
      const statement = parseMigrationResolutionRequest(request); const operator = parseMigrationResolutionActor(actor); if (!statement.ok || !operator.ok) throw new Error("invalid managed migration resolution");
      const current = await store.read(); if (current?.operation.run !== statement.value.run || current.owner.app !== statement.value.app || current.operation.cancelRequestedAt !== null) throw new Error("managed migration resolution lacks lifecycle ownership");
      const source = await store.source(); const deadline = ports.now() + 10_000;
      if (await bounded(deadline, () => ports.authorize(source, { kind: "migration-resolution", request: statement.value, actor: operator.value })) !== true) throw new Error("managed migration resolution is not authorized");
      const observed = await bounded(deadline, () => ports.admission.observe(identity(current), managedLifecycleDescription(source).admission));
      const recorded = current.operation.preparation?.sequence?.steps.some((step) => step.id === statement.value.step && step.resolution !== undefined) ?? false;
      if (observed !== "reserved" && !(recorded && observed?.startsWith("settled-") === true)) throw new Error("managed migration resolution is not authorized");
      return store.resolveMigration(statement.value, operator.value, ports.jobs);
    },
    tick: () => { if (flight !== undefined) return flight; const result = tick(); flight = result; void result.finally(() => { flight = undefined; }).catch(() => undefined); return result; },
  });
};
