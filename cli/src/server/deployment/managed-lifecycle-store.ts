import { createHash } from "node:crypto";
import { z } from "zod";
import { parseDataOwnership } from "../../contracts/owned-volume.ts";
import type { DataOwnership } from "../../contracts/owned-volume.ts";
import { parseManagedLifecycleSource, managedLifecycleSourceDigest, managedLifecycleDescription } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import { parseManagedMaintenanceQuiescence } from "./managed-maintenance-quiescence.ts";
import { parseManagedGroupPreparation } from "./managed-group-preparation.ts";
import { parseManagedConsumerState } from "./managed-consumer-state.ts";
import { parseManagedGroupVerification } from "./managed-group-verification.ts";
import { managedVerificationSnapshot } from "./managed-verification-source.ts";
import { parseManagedRelease, managedReleaseDigest } from "./managed-release.ts";
import { claimJournal } from "./journal-claim.ts";
import { resolveManagedPreparationMigration } from "./managed-migration-resolution.ts";
import type { MigrationResolutionActor, MigrationResolutionRequest } from "../../contracts/migration-resolution.ts";
import { parseMigrationResolutionReceipt } from "../../contracts/migration-resolution.ts";
import { managedSuccessfulInventoryCarry, managedRecoveredInventoryCarry, managedUnstartedInventoryCarry } from "./managed-lifecycle-inventory.ts";
import { managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import { parseManagedGroupCompensation } from "./managed-group-compensation.ts";
import { managedUnstartedSource } from "./managed-unstarted-source.ts";
import { managedRecoverySource } from "./managed-recovery-safety.ts";
import type { OperationJournal } from "./operation.ts";

import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
export { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
export type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
type Ports = { readonly now: () => number; readonly retain: (bytes: string) => Promise<string>; readonly read: (digest: string) => Promise<string> };
type Child = "quiescence" | "preparation" | "consumers" | "verification" | "recovery" | "recoveryVerification";

/** One app writer and private child views. Promotion and the final verification become one synchronized replacement; capacity settlement follows separately. */
export const managedLifecycleStore = (journal: OperationJournal, requested: DataOwnership, ports: Ports) => {
  const parsed = parseDataOwnership(requested); if (!parsed.ok) throw new Error("invalid managed lifecycle writer scope"); const owner = parsed.value;
  claimJournal(journal, "managed lifecycle store already has an owner");
  // eslint-disable-next-line functional/no-let -- serializes filesystem changes without holding this queue during native effects
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- uncertain synchronization invalidates this writer
  let poisoned = false;
  const serial = <T>(call: () => Promise<T>) => { const result = pending.then(() => { if (poisoned) throw new Error("managed lifecycle synchronization uncertain; reopen"); return call(); }); pending = result.then(() => undefined, () => undefined); return result; };
  const load = async () => { const raw = await journal.read(); if (raw === undefined) return undefined; const value = parseManagedLifecycleStore(raw); if (!same(value.owner, owner)) throw new Error("managed lifecycle writer scope disagrees"); return value; };
  const required = async () => { const state = await load(); if (state === undefined) throw new Error("managed lifecycle intent missing"); return state; };
  const write = async (value: ManagedLifecycleStore) => { const state = parseManagedLifecycleStore(value); try { await journal.write(state); } catch { poisoned = true; throw new Error("managed lifecycle synchronization uncertain; reopen"); } return state; };
  const time = (minimum = 1) => { const at = ports.now(); if (!Number.isSafeInteger(at) || at < minimum) throw new Error("managed lifecycle clock unavailable"); return at; };
  const metadata = async <T>(call: () => Promise<T>) => {
    const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, 10_000);
    try { const value = await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); if (value === undefined) throw new Error("managed lifecycle metadata unavailable"); return value; } finally { clearTimeout(timer); }
  };
  const retain = (bytes: string) => metadata(() => ports.retain(bytes));
  const artifact = async (digest: string) => { const bytes = await metadata(() => ports.read(digest)); if (hash(bytes) !== digest) throw new Error("managed lifecycle artifact integrity failed"); return bytes; };
  const source = async (state: ManagedLifecycleStore) => {
    const bytes = await artifact(state.operation.source); const raw: unknown = JSON.parse(bytes); const value = parseManagedLifecycleSource(raw); const description = managedLifecycleDescription(value);
    if (bytes !== JSON.stringify(value) || value.run !== state.operation.run || value.action !== state.operation.action || value.createdAt !== state.operation.createdAt || !same(value.candidate.infrastructure.ownership, owner) || description.admission.planDigest !== state.operation.plan || description.previous !== state.operation.previous || state.operation.previousPlan !== (description.admission.previous === null ? null : managedApplicationDigest(description.admission.previous)) || description.admissionDeadline !== state.operation.admissionDeadline || description.deadline !== state.operation.deadline || state.operation.compatibilityFencedAt !== null && value.candidate.rollout.rollback_compatible) throw new Error("managed lifecycle source disagrees"); return value;
  };
  const views = new Map<string, OperationJournal>();
  const child = (name: Child, run: string) => {
    if (!z.uuid().safeParse(run).success) throw new Error("invalid managed lifecycle child run");
    const key = `${run}:${name}`; const existing = views.get(key); if (existing !== undefined) return existing;
    const view: OperationJournal = { read: () => serial(async () => { const state = await required(); if (state.operation.run !== run) throw new Error("managed lifecycle child lost operation ownership"); return state.operation[name] ?? undefined; }), write: (raw) => serial(async () => {
      const current = await required(); const operation = current.operation; if (operation.run !== run) throw new Error("managed lifecycle child lost operation ownership"); const value = name === "quiescence" ? parseManagedMaintenanceQuiescence(raw) : name === "preparation" ? parseManagedGroupPreparation(raw) : name === "consumers" ? parseManagedConsumerState(raw) : name === "recovery" ? parseManagedGroupCompensation(raw) : parseManagedGroupVerification(raw);
      const expected = name === "quiescence" ? "quiescing" : name === "preparation" ? "preparing" : name === "consumers" ? "updating" : name === "recovery" ? "recovering" : name === "recoveryVerification" ? "recovery-verifying" : "verifying";
      if (operation.phase !== expected && !(operation.phase === "held" && operation.cancelRequestedAt !== null)) throw new Error("managed lifecycle child lost ownership");
      if (name !== "verification" && name !== "recoveryVerification" || value.phase !== "verified" || !("verified" in value) || value.verified === null || operation.phase !== expected || name === "verification" && operation.cancelRequestedAt !== null) {
        await write({ ...current, operation: { ...operation, [name]: value } }); return;
      }
      const runSource = await source(current);
      const recoveryInput: unknown = name === "recoveryVerification" ? JSON.parse(await artifact(operation.recoverySource ?? "")) : undefined;
      const snapshot = name === "verification" ? managedVerificationSnapshot({ kind: "deployment", application: runSource.candidate, certificate: operation.consumers }) : managedVerificationSnapshot({ kind: "recovery", application: runSource.previous?.source.application, certificate: operation.recovery, recoverySource: recoveryInput });
      const release = parseManagedRelease({ version: 1, source: snapshot.source, verification: value }); const record = managedReleaseDigest(release);
      if (await retain(JSON.stringify(release)) !== record) throw new Error("managed lifecycle release retention failed");
      const now = time(operation.createdAt); const verified = release.verification.verified; if (verified === null) throw new Error("managed lifecycle final observations missing");
      if (now >= operation.deadline || now >= value.deadline) { await write({ ...current, operation: { ...operation, [name]: value, phase: "held", reason: "deadline" } }); return; }
      if (now - verified.at > 2000) { await write({ ...current, operation: { ...operation, [name]: { ...value, phase: "running", verified: null } } }); return; }
      const active = Object.freeze({ record, plan: snapshot.plan, run: operation.run, verifiedAt: verified.at, epoch: current.compatibilityEpoch });
      await write({ ...current, active, lastGood: active, operation: { ...operation, [name]: value, outcome: name === "verification" ? "deployed" : "rolled-back", settlement: name === "verification" ? "target" : "previous", phase: "settling", enteredAt: now } });
    }) };
    // eslint-disable-next-line functional/immutable-data -- one claimed view per child
    views.set(key, view); return view;
  };
  return Object.freeze({
    read: () => serial(load),
    source: () => serial(async () => source(await required())),
    beginUnstarted: (expected: string) => serial(async () => {
      const state = await required(); if (hash(JSON.stringify(state.operation)) !== expected) return state;
      managedUnstartedSource(state, await source(state)); const at = time(state.operation.createdAt); const reason = state.operation.reason;
      if (reason === null) throw new Error("unstarted lifecycle failure cause missing");
      return write({ ...state, operation: { ...state.operation, unstartedAt: at, failure: { reason, at }, reason: null, phase: "settling", enteredAt: at, outcome: state.operation.previous === null ? "absent" : "unchanged", settlement: state.operation.previous === null ? "absent" : "previous" } });
    }),
    beginRecovery: (expected: string, startedAt: number) => serial(async () => {
      const state = await required(); if (hash(JSON.stringify(state.operation)) !== expected || state.operation.recoverySource !== null) return state;
      const snapshot = managedRecoverySource(state, await source(state), startedAt); const bytes = JSON.stringify(snapshot.source); const identity = hash(bytes);
      if (await retain(bytes) !== identity || time(state.operation.createdAt) >= startedAt + 90_000) throw new Error("managed recovery source retention failed");
      const reason = state.operation.reason; if (reason === null) throw new Error("managed recovery failure cause missing");
      return write({ ...state, operation: { ...state.operation, phase: "recovering", reason: null, failure: { reason, at: startedAt }, enteredAt: startedAt, recoverySource: identity, recoveryStartedAt: startedAt, recoveryDeadline: startedAt + 90_000 } });
    }),
    verifyRecovery: () => serial(async () => {
      const state = await required(); const operation = state.operation; const recovery = operation.recovery;
      if (operation.phase !== "recovering" || recovery?.phase !== "verified" || recovery.verifiedAt === null) throw new Error("managed recovery convergence missing");
      if (operation.previousPlan !== null) return write({ ...state, operation: { ...operation, phase: "recovery-verifying", enteredAt: recovery.verifiedAt } });
      const at = time(operation.createdAt); if (at >= operation.deadline || at >= recovery.deadline) return write({ ...state, operation: { ...operation, phase: "held", reason: "deadline" } });
      if (at - recovery.verifiedAt > 2000) return write({ ...state, operation: { ...operation, recovery: { ...recovery, phase: "recovering", verifiedAt: null, nodes: recovery.nodes.map((node) => Object.freeze({ ...node, routed: null })) } } });
      return write({ ...state, active: null, operation: { ...operation, phase: "settling", enteredAt: at, outcome: "absent", settlement: "absent" } });
    }),
    fenceCompatibility: (run: string, expected: ManagedLifecycleStore["operation"]["phase"]) => serial(async () => {
      const state = await required(); const operation = state.operation;
      if (operation.run !== run || operation.phase !== expected || !["preparing", "updating", "verifying"].includes(operation.phase) || operation.cancelRequestedAt !== null || !operation.admitted || time(operation.createdAt) >= operation.deadline) return false;
      const input = await source(state); if (input.candidate.rollout.rollback_compatible || operation.compatibilityFencedAt !== null) return true;
      const next = state.compatibilityEpoch + 1; if (!Number.isSafeInteger(next)) throw new Error("managed compatibility epoch exhausted"); const at = time(operation.createdAt); if (at >= operation.deadline) return false;
      await write({ ...state, compatibilityEpoch: next, operation: { ...operation, compatibilityEpoch: next, compatibilityFencedAt: at } }); return true;
    }),
    resolveMigration: (request: MigrationResolutionRequest, actor: MigrationResolutionActor, native: Parameters<typeof resolveManagedPreparationMigration>[4]["native"]) => serial(async () => {
      const state = await required(); const operation = state.operation;
      if (request.app !== owner.app || request.run !== operation.run || operation.preparation === null || operation.cancelRequestedAt !== null || !operation.admitted) throw new Error("managed migration resolution lacks lifecycle ownership");
      const preparation = operation.preparation; const recorded = preparation.sequence?.steps.find((step) => step.id === request.step)?.resolution;
      if (recorded !== undefined && (recorded.outcome !== request.outcome || recorded.reason !== request.reason || !same(recorded.actor, actor))) throw new Error("migration outcome was already resolved differently");
      if (recorded !== undefined) { const receipt = operation.resolutionReceipts.find((value) => value.resolution === recorded.id); if (receipt === undefined) throw new Error("managed migration resolution receipt is missing"); return Object.freeze({ state, receipt }); }
      if (operation.recoverySource !== null) throw new Error("migration resolution cannot resume a superseded forward rollout");
      if (operation.phase !== "held") throw new Error("managed lifecycle is not held for resolution");
      const result = await metadata(async () => resolveManagedPreparationMigration(preparation, await source(state), request, actor, { read: artifact, now: ports.now, native }));
      const resumed = result.receipt.disposition === "continue" && time(operation.createdAt) < operation.deadline;
      const checked = parseMigrationResolutionReceipt({ ...result.receipt, disposition: resumed ? "continue" : "failed" }); if (!checked.ok) throw new Error("invalid managed migration resolution receipt"); const receipt = checked.value;
      const next = await write({ ...state, operation: { ...operation, preparation: result.preparation, resolutionReceipts: [...operation.resolutionReceipts, receipt], phase: resumed ? "preparing" : "held", reason: resumed ? null : result.receipt.disposition === "continue" || result.preparation.reason === "deadline" ? "deadline" : "preparation" } });
      return Object.freeze({ state: next, receipt });
    }),
    child,
    begin: (input: ManagedLifecycleSource) => {
      const value = parseManagedLifecycleSource(input); const description = managedLifecycleDescription(value); const identity = managedLifecycleSourceDigest(value);
      if (!same(value.candidate.infrastructure.ownership, owner)) return Promise.reject(new Error("managed lifecycle source ownership disagrees"));
      return serial(async () => {
        const current = await load(); if (current?.operation.run === value.run) { if (current.operation.source !== identity) throw new Error("managed lifecycle run conflicts"); await source(current); return current; }
        if (current === undefined ? value.previous !== null : current.operation.phase !== "complete" || (current.active?.record ?? null) !== description.previous || Number(value.action.split(":")[1]) <= current.sequence) throw new Error("managed lifecycle previous release or settled operation disagrees");
        const carried = current?.operation.unstartedAt !== null && current?.operation.unstartedAt !== undefined ? managedUnstartedInventoryCarry(await source(current), value) : current?.operation.outcome === "rolled-back" || current?.operation.outcome === "absent" ? managedRecoveredInventoryCarry(await source(current), current.operation.recovery, value) : managedSuccessfulInventoryCarry(current === undefined ? null : await source(current), value); if (!carried.ok) throw new Error(carried.error);
        if (value.restore !== null || (current?.compatibilityEpoch ?? 0) > 0) {
          if (current === undefined) throw new Error("managed restore lacks verified release history");
          const selected = await metadata(async () => {
            const deadline = performance.now() + 10_000;
            // eslint-disable-next-line functional/no-let -- follows only synchronized, content-addressed history under one metadata deadline
            let cursor = current;
            // eslint-disable-next-line functional/no-let -- remembers an old match while searching for any subsequently verified compatible copy
            let historical: ManagedLifecycleStore["active"] = null;
            for (;;) {
              if (performance.now() >= deadline) throw new Error("managed release history inspection expired");
              const release = [cursor.active, cursor.lastGood].find((item) => item !== null && (value.restore === null ? item.plan === description.admission.planDigest : item.record === value.restore));
              if (release !== undefined && release !== null) { if (value.restore !== null || release.epoch === current.compatibilityEpoch) return release; historical = release; }
              if (cursor.history === null) { if (value.restore !== null) throw new Error("unknown managed restore record"); return Object.freeze({ historical }); }
              const bytes = await artifact(cursor.history); const raw: unknown = JSON.parse(bytes); const archive = z.object({ previous: digest.nullable(), state: z.unknown() }).strict().parse(raw); const prior = parseManagedLifecycleStore(archive.state);
              if (!same(prior.owner, owner) || archive.previous !== prior.history || prior.sequence >= cursor.sequence || prior.compatibilityEpoch > cursor.compatibilityEpoch) throw new Error("managed restore history disagrees"); cursor = prior;
            }
          });
          const release = "historical" in selected ? selected.historical : selected;
          if (release !== null && release.plan !== description.admission.planDigest) throw new Error("managed restore candidate differs from its verified release");
          if (release !== null && release.epoch !== current.compatibilityEpoch) throw new Error("managed restore crosses a data compatibility fence; forward recovery is required");
        }
        if (current?.active !== null && current?.active !== undefined && current.active.epoch !== current.compatibilityEpoch && value.candidate.rollout.strategy === "rolling") throw new Error("managed rolling baseline crosses a data compatibility fence");
        const at = time(value.createdAt); if (at >= description.admissionDeadline) throw new Error("managed lifecycle admission deadline expired");
        if (await retain(JSON.stringify(value)) !== identity) throw new Error("managed lifecycle source retention failed");
        const historyBytes = current === undefined ? null : JSON.stringify({ previous: current.history, state: current });
        const history = historyBytes === null ? null : await retain(historyBytes); if (historyBytes !== null && history !== hash(historyBytes)) throw new Error("managed lifecycle history retention failed");
        const compatibilityEpoch = current?.compatibilityEpoch ?? 0;
        const state = await write({ version: 3, protocol: "managed-v3", runtime: "swarm", owner, sequence: Number(value.action.split(":")[1]), compatibilityEpoch, active: current?.active ?? null, lastGood: current?.lastGood ?? null, history,
          operation: { run: value.run, action: value.action, source: identity, plan: description.admission.planDigest, previous: description.previous, previousPlan: description.admission.previous === null ? null : managedApplicationDigest(description.admission.previous), createdAt: value.createdAt, admissionDeadline: description.admissionDeadline, deadline: description.deadline, phase: "admitting", enteredAt: at, reason: null, outcome: null, settlement: null, unstartedAt: null, failure: null, recoverySource: null, recoveryStartedAt: null, recoveryDeadline: null, recovery: null, recoveryVerification: null, admitted: false, settled: false, cancelRequestedAt: null, compatibilityEpoch, compatibilityFencedAt: null, resolutionReceipts: [], quiescence: null, preparation: null, consumers: null, verification: null } });
        // eslint-disable-next-line functional/immutable-data -- obsolete views retain their bound run and can never write the next operation
        views.clear(); return state;
      });
    },
    admit: () => serial(async () => { const state = await required(); const at = time(state.operation.createdAt); if (state.operation.phase !== "admitting") return state; if (at >= state.operation.admissionDeadline) return write({ ...state, operation: { ...state.operation, phase: "held", reason: "deadline" } }); const run = await source(state); return write({ ...state, operation: { ...state.operation, admitted: true, phase: run.candidate.rollout.strategy === "maintenance" ? "quiescing" : "preparing", enteredAt: at } }); }),
    enter: (expected: "quiescing" | "preparing" | "updating", next: "preparing" | "updating" | "verifying", at: number) => serial(async () => { const state = await required(); if (state.operation.phase !== expected) return state;
      const transition = expected === "quiescing" ? next === "preparing" && state.operation.quiescence?.phase === "complete" && at === state.operation.quiescence.verifiedAt : expected === "preparing" ? next === "updating" && state.operation.preparation?.phase === "ready" && at === (state.operation.preparation.consumerDeadline ?? 0) - 90_000 : next === "verifying" && state.operation.consumers?.phase === "ready" && at === state.operation.consumers.verifiedAt;
      if (!transition) throw new Error("managed lifecycle handoff disagrees"); return write({ ...state, operation: { ...state.operation, phase: next, enteredAt: at } });
    }),
    hold: (reason: NonNullable<ManagedLifecycleStore["operation"]["reason"]>) => serial(async () => { const state = await required(); return ["complete", "settling", "held"].includes(state.operation.phase) ? state : write({ ...state, operation: { ...state.operation, phase: "held", reason } }); }),
    cancel: () => serial(async () => { const state = await required(); if (["complete", "settling"].includes(state.operation.phase) || state.operation.cancelRequestedAt !== null) return state; const at = time(state.operation.createdAt); return write({ ...state, operation: { ...state.operation, cancelRequestedAt: at, ...(["recovering", "recovery-verifying"].includes(state.operation.phase) ? {} : { phase: "held", reason: "cancellation" }) } }); }),
    settle: () => serial(async () => { const state = await required(); if (state.operation.phase !== "settling") return state; return write({ ...state, operation: { ...state.operation, phase: "complete", settled: true } }); }),
  });
};
