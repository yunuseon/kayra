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
import type { OperationJournal } from "./operation.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pointer = z.object({ record: digest, plan: digest, run: z.uuid(), verifiedAt: positive }).strict().readonly();
const phase = z.enum(["admitting", "quiescing", "preparing", "updating", "verifying", "settling", "complete", "held"]);
const schema = z.object({ version: z.literal(1), protocol: z.literal("managed-v3"), runtime: z.literal("swarm"), owner: z.unknown(), sequence: positive,
  active: pointer.nullable(), lastGood: pointer.nullable(), history: digest.nullable(),
  operation: z.object({ run: z.uuid(), action: z.string().max(80), source: digest, plan: digest, previous: digest.nullable(), createdAt: positive, admissionDeadline: positive, deadline: positive,
    phase, enteredAt: positive, reason: z.enum(["admission", "deadline", "authorization", "quiescence", "preparation", "consumers", "verification", "cancellation"]).nullable(),
    admitted: z.boolean(), settled: z.boolean(), cancelRequestedAt: positive.nullable(), resolutionReceipts: z.array(z.unknown()).max(128).readonly().default([]),
    quiescence: z.unknown().nullable(), preparation: z.unknown().nullable(), consumers: z.unknown().nullable(), verification: z.unknown().nullable(),
  }).strict().readonly(),
}).strict().readonly();
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export const parseManagedLifecycleStore = (input: unknown) => {
  const raw = schema.parse(input); const owner = parseDataOwnership(raw.owner); if (!owner.ok) throw new Error("invalid managed lifecycle ownership"); const operation = raw.operation;
  const quiescence = operation.quiescence === null ? null : parseManagedMaintenanceQuiescence(operation.quiescence);
  const preparation = operation.preparation === null ? null : parseManagedGroupPreparation(operation.preparation);
  const consumers = operation.consumers === null ? null : parseManagedConsumerState(operation.consumers);
  const verification = operation.verification === null ? null : parseManagedGroupVerification(operation.verification);
  const resolutionReceipts = Object.freeze(operation.resolutionReceipts.map((raw) => { const receipt = parseMigrationResolutionReceipt(raw); if (!receipt.ok) throw new Error("invalid managed migration resolution receipt"); return receipt.value; }));
  if (new Set(resolutionReceipts.map((receipt) => receipt.step)).size !== resolutionReceipts.length || resolutionReceipts.some((receipt) => {
    const audit = preparation?.sequence?.steps.find((step) => step.id === receipt.step)?.resolution;
    return audit === undefined || receipt.app !== owner.value.app || receipt.run !== operation.run || receipt.resolution !== audit.id || receipt.outcome !== audit.outcome || receipt.recordedAt !== audit.at || receipt.disposition === "cancelled" || receipt.disposition === "continue" && (audit.outcome !== "applied" || audit.at >= (preparation?.sequence?.deadline ?? 0) || audit.at >= operation.deadline);
  }) || preparation?.sequence?.steps.some((step) => step.resolution !== undefined && !resolutionReceipts.some((receipt) => receipt.resolution === step.resolution?.id))) throw new Error("managed migration resolution receipt disagrees");
  if (operation.action !== `${owner.value.incarnation}:${String(raw.sequence)}` || operation.admissionDeadline !== operation.createdAt + 90_000 || operation.deadline <= operation.admissionDeadline || operation.enteredAt < operation.createdAt ||
    operation.cancelRequestedAt !== null && operation.cancelRequestedAt < operation.createdAt || (operation.phase === "held") !== (operation.reason !== null) || operation.settled && operation.phase !== "complete" || operation.phase === "complete" && !operation.settled ||
    [quiescence, preparation, consumers, verification].some((child) => child !== null && (child.app !== owner.value.app || child.incarnation !== owner.value.incarnation || child.dataOwner !== owner.value.dataOwner || child.run !== operation.run || child.plan !== operation.plan)) ||
    quiescence !== null && (quiescence.action !== operation.action || quiescence.createdAt < operation.createdAt || quiescence.deadline > operation.deadline) ||
    preparation !== null && (preparation.action !== operation.action || preparation.createdAt < operation.createdAt || preparation.migrationDeadline > operation.deadline) ||
    consumers !== null && (preparation?.phase !== "ready" || consumers.action !== operation.action || consumers.deadline !== preparation.consumerDeadline || consumers.preparation !== hash(JSON.stringify(preparation))) ||
    verification !== null && (consumers?.phase !== "ready" || verification.deadline > operation.deadline) ||
    ["quiescing", "preparing", "updating", "verifying", "settling", "complete"].includes(operation.phase) && !operation.admitted ||
    ["updating", "verifying", "settling", "complete"].includes(operation.phase) && preparation?.phase !== "ready" ||
    ["verifying", "settling", "complete"].includes(operation.phase) && consumers?.phase !== "ready" ||
    ["settling", "complete"].includes(operation.phase) && (verification?.phase !== "verified" || raw.active?.plan !== operation.plan || raw.active.run !== operation.run || raw.active.verifiedAt !== verification.verified?.at || !same(raw.active, raw.lastGood))) throw new Error("inconsistent managed lifecycle store");
  return Object.freeze({ ...raw, owner: owner.value, operation: Object.freeze({ ...operation, resolutionReceipts, quiescence, preparation, consumers, verification }) });
};
export type ManagedLifecycleStore = ReturnType<typeof parseManagedLifecycleStore>;
type Ports = { readonly now: () => number; readonly retain: (bytes: string) => Promise<string>; readonly read: (digest: string) => Promise<string> };
type Child = "quiescence" | "preparation" | "consumers" | "verification";

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
    if (bytes !== JSON.stringify(value) || value.run !== state.operation.run || value.action !== state.operation.action || value.createdAt !== state.operation.createdAt || !same(value.candidate.infrastructure.ownership, owner) || description.admission.planDigest !== state.operation.plan || description.previous !== state.operation.previous || description.admissionDeadline !== state.operation.admissionDeadline || description.deadline !== state.operation.deadline) throw new Error("managed lifecycle source disagrees"); return value;
  };
  const views = new Map<string, OperationJournal>();
  const child = (name: Child, run: string) => {
    if (!z.uuid().safeParse(run).success) throw new Error("invalid managed lifecycle child run");
    const key = `${run}:${name}`; const existing = views.get(key); if (existing !== undefined) return existing;
    const view: OperationJournal = { read: () => serial(async () => { const state = await required(); if (state.operation.run !== run) throw new Error("managed lifecycle child lost operation ownership"); return state.operation[name] ?? undefined; }), write: (raw) => serial(async () => {
      const current = await required(); const operation = current.operation; if (operation.run !== run) throw new Error("managed lifecycle child lost operation ownership"); const value = name === "quiescence" ? parseManagedMaintenanceQuiescence(raw) : name === "preparation" ? parseManagedGroupPreparation(raw) : name === "consumers" ? parseManagedConsumerState(raw) : parseManagedGroupVerification(raw);
      const expected = name === "quiescence" ? "quiescing" : name === "preparation" ? "preparing" : name === "consumers" ? "updating" : "verifying";
      if (operation.phase !== expected && !(operation.phase === "held" && operation.cancelRequestedAt !== null)) throw new Error("managed lifecycle child lost ownership");
      if (name !== "verification" || value.phase !== "verified" || !("verified" in value) || value.verified === null || operation.phase !== "verifying" || operation.cancelRequestedAt !== null) {
        await write({ ...current, operation: { ...operation, [name]: value } }); return;
      }
      const runSource = await source(current); if (operation.consumers === null) throw new Error("managed lifecycle convergence missing");
      const snapshot = managedVerificationSnapshot({ kind: "deployment", application: runSource.candidate, certificate: operation.consumers });
      const release = parseManagedRelease({ version: 1, source: snapshot.source, verification: value }); const record = managedReleaseDigest(release);
      if (await retain(JSON.stringify(release)) !== record) throw new Error("managed lifecycle release retention failed");
      const now = time(operation.createdAt); const verified = release.verification.verified; if (verified === null) throw new Error("managed lifecycle final observations missing");
      if (now >= operation.deadline || now >= value.deadline) { await write({ ...current, operation: { ...operation, verification: value, phase: "held", reason: "deadline" } }); return; }
      if (now - verified.at > 2000) { await write({ ...current, operation: { ...operation, verification: { ...value, phase: "running", verified: null } } }); return; }
      const active = Object.freeze({ record, plan: operation.plan, run: operation.run, verifiedAt: verified.at });
      await write({ ...current, active, lastGood: active, operation: { ...operation, verification: value, phase: "settling", enteredAt: now } });
    }) };
    // eslint-disable-next-line functional/immutable-data -- one claimed view per child
    views.set(key, view); return view;
  };
  return Object.freeze({
    read: () => serial(load),
    source: () => serial(async () => source(await required())),
    resolveMigration: (request: MigrationResolutionRequest, actor: MigrationResolutionActor, native: Parameters<typeof resolveManagedPreparationMigration>[4]["native"]) => serial(async () => {
      const state = await required(); const operation = state.operation;
      if (request.app !== owner.app || request.run !== operation.run || operation.preparation === null || operation.cancelRequestedAt !== null || !operation.admitted) throw new Error("managed migration resolution lacks lifecycle ownership");
      const preparation = operation.preparation; const recorded = preparation.sequence?.steps.find((step) => step.id === request.step)?.resolution;
      if (recorded !== undefined && (recorded.outcome !== request.outcome || recorded.reason !== request.reason || !same(recorded.actor, actor))) throw new Error("migration outcome was already resolved differently");
      if (recorded !== undefined) { const receipt = operation.resolutionReceipts.find((value) => value.resolution === recorded.id); if (receipt === undefined) throw new Error("managed migration resolution receipt is missing"); return Object.freeze({ state, receipt }); }
      if (recorded === undefined && operation.phase !== "held") throw new Error("managed lifecycle is not held for resolution");
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
        if (current === undefined ? value.previous !== null : current.operation.phase !== "complete" || current.active?.record !== description.previous || Number(value.action.split(":")[1]) <= current.sequence) throw new Error("managed lifecycle previous release or settled operation disagrees");
        const at = time(value.createdAt); if (at >= description.admissionDeadline) throw new Error("managed lifecycle admission deadline expired");
        if (await retain(JSON.stringify(value)) !== identity) throw new Error("managed lifecycle source retention failed");
        const historyBytes = current === undefined ? null : JSON.stringify({ previous: current.history, operation: current.operation });
        const history = historyBytes === null ? null : await retain(historyBytes); if (historyBytes !== null && history !== hash(historyBytes)) throw new Error("managed lifecycle history retention failed");
        const state = await write({ version: 1, protocol: "managed-v3", runtime: "swarm", owner, sequence: Number(value.action.split(":")[1]), active: current?.active ?? null, lastGood: current?.lastGood ?? null, history,
          operation: { run: value.run, action: value.action, source: identity, plan: description.admission.planDigest, previous: description.previous, createdAt: value.createdAt, admissionDeadline: description.admissionDeadline, deadline: description.deadline, phase: "admitting", enteredAt: at, reason: null, admitted: false, settled: false, cancelRequestedAt: null, resolutionReceipts: [], quiescence: null, preparation: null, consumers: null, verification: null } });
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
    cancel: () => serial(async () => { const state = await required(); if (["complete", "settling"].includes(state.operation.phase) || state.operation.cancelRequestedAt !== null) return state; const at = time(state.operation.createdAt); return write({ ...state, operation: { ...state.operation, cancelRequestedAt: at, phase: "held", reason: "cancellation" } }); }),
    settle: () => serial(async () => { const state = await required(); if (state.operation.phase !== "settling") return state; return write({ ...state, operation: { ...state.operation, phase: "complete", settled: true } }); }),
  });
};
