import { createHash } from "node:crypto";
import { z } from "zod";
import { parseManagedForwardSelectionRequest } from "../../contracts/managed-forward-selection.ts";
import { parseMigrationResolutionActor } from "../../contracts/migration-resolution.ts";
import { parseRegistrationGeneration } from "../../contracts/registration-generation.ts";
import { parseDataOwnership } from "../../contracts/owned-volume.ts";
import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { parseManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import { managedDeploymentEvidence } from "./managed-deployment-evidence.ts";
import { managedHistorySelection } from "./managed-history-selection.ts";
import { settledMigrationPrefix } from "./migration-prefix.ts";
import { claimJournal } from "./journal-claim.ts";
import type { OperationJournal } from "./operation.ts";

const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const selectionInput = z.object({ state: z.unknown(), source: z.unknown(), registration: z.unknown(), request: z.unknown(), actor: z.unknown(), createdAt: time.optional() }).strict();
export const managedForwardSelectionInput = (input: unknown) => {
  const raw = selectionInput.parse(input);
  const state = parseManagedLifecycleStore(raw.state); const source = parseManagedLifecycleSource(raw.source); const registration = parseRegistrationGeneration(raw.registration); const request = parseManagedForwardSelectionRequest(raw.request); const actor = parseMigrationResolutionActor(raw.actor);
  if (!registration.ok || !request.ok || !actor.ok || state.owner.app !== request.value.app || state.operation.run !== request.value.blockedRun || state.operation.run === request.value.request || registration.value.app !== state.owner.app || registration.value.incarnation !== state.owner.incarnation || !same(source.candidate.infrastructure.ownership, state.owner) ||
    state.operation.source !== hash(source) || state.operation.run !== source.run || state.operation.action !== source.action || state.operation.createdAt !== source.createdAt || state.operation.phase !== "held" || !state.operation.admitted || state.operation.settled || state.operation.recoverySource !== null || state.operation.compatibilityFencedAt === null && source.version !== 3 || source.candidate.rollout.strategy !== "maintenance" || settledMigrationPrefix(state.operation.preparation?.sequence ?? null) === undefined) throw new Error("forward selection requires a resolved held maintenance data epoch and exact ownership");
  return Object.freeze({ state, source, registration: registration.value, request: request.value, actor: actor.value });
};
const source = (input: unknown) => {
  const raw = z.object({ version: z.literal(1), selection: z.unknown(), createdAt: time, preparationDeadline: time, buildDeadline: time }).strict().readonly().parse(input); const chosen = managedForwardSelectionInput(raw.selection);
  if (raw.preparationDeadline !== raw.createdAt + 90_000 || raw.buildDeadline !== raw.createdAt + 45 * 60_000 || raw.createdAt < (chosen.state.operation.compatibilityFencedAt ?? (chosen.source.version === 3 ? chosen.state.operation.enteredAt : Infinity))) throw new Error("forward selection deadlines disagree");
  return Object.freeze({ ...raw, selection: chosen });
};
const audit = (value: ReturnType<typeof source>) => Object.freeze({ version: 1 as const, owner: value.selection.state.owner, registration: value.selection.registration,
  blocked: Object.freeze({ run: value.selection.state.operation.run, source: value.selection.state.operation.source, checkpoint: hash(value.selection.state), compatibilityEpoch: value.selection.state.compatibilityEpoch }),
  request: value.selection.request, actor: value.selection.actor, createdAt: value.createdAt, preparationDeadline: value.preparationDeadline, buildDeadline: value.buildDeadline });
/** Pure canonical intent, so the owning index can authorize before registering initialization. */
export const managedForwardSelectionIntent = (input: unknown, createdAt: number) => {
  const value = source({ version: 1, selection: managedForwardSelectionInput(input), createdAt, preparationDeadline: createdAt + 90_000, buildDeadline: createdAt + 45 * 60_000 });
  return Object.freeze({ source: value, audit: audit(value) });
};
/** Read-only validation; callers bound the entire inspection before publishing any intent. */
export const verifyManagedForwardSelectionBaseline = async (value: ReturnType<typeof managedForwardSelectionIntent>["source"], ports: { readonly read: (digest: string) => Promise<string>; readonly now: () => number }) => {
  const chosen = value.selection; await managedDeploymentEvidence(chosen.state, chosen.source, ports);
  const inspected = await managedHistorySelection(chosen.state, { restore: null, plan: null, commit: chosen.request.commit }, { read: ports.read, expired: () => ports.now() >= value.preparationDeadline });
  if ("historical" in inspected && inspected.historical !== null && inspected.historical.epoch !== chosen.state.compatibilityEpoch) throw new Error("forward selection cannot choose an earlier data epoch");
  return true;
};
const schema = z.object({ version: z.literal(1), source: digest, audit: z.unknown(), id: digest }).strict().readonly();
const parseState = (input: unknown) => {
  const raw = schema.parse(input);
  const value = z.object({ version: z.literal(1), owner: z.unknown(), registration: z.unknown(), blocked: z.object({ run: z.uuid(), source: digest, checkpoint: digest, compatibilityEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict().readonly(), request: z.unknown(), actor: z.unknown(), createdAt: time, preparationDeadline: time, buildDeadline: time }).strict().readonly().parse(raw.audit);
  const owner = parseDataOwnership(value.owner); const registration = parseRegistrationGeneration(value.registration); const request = parseManagedForwardSelectionRequest(value.request); const actor = parseMigrationResolutionActor(value.actor);
  if (!owner.ok || !registration.ok || !request.ok || !actor.ok || registration.value.app !== owner.value.app || registration.value.incarnation !== owner.value.incarnation || request.value.app !== owner.value.app || request.value.blockedRun !== value.blocked.run || request.value.request === value.blocked.run || value.preparationDeadline !== value.createdAt + 90_000 || value.buildDeadline !== value.createdAt + 45 * 60_000) throw new Error("invalid managed forward selection audit");
  const parsed = Object.freeze({ ...value, owner: owner.value, registration: registration.value, request: request.value, actor: actor.value }); if (hash(parsed) !== raw.id) throw new Error("managed forward selection audit identity disagrees");
  return Object.freeze({ ...raw, audit: parsed });
};
export type ManagedForwardSelection = ReturnType<typeof parseState>;
type Ports = { readonly now: () => number; readonly read: (digest: string) => Promise<string>; readonly retain: (bytes: string) => Promise<string>;
  /** Independent owner observation, loaded under the app lifecycle writer by composition. */
  readonly current: () => Promise<{ readonly status: "held"; readonly checkpoint: string; readonly registration: unknown } | undefined>;
  readonly authorize: (audit: ManagedForwardSelection["audit"]) => Promise<boolean> };

/** Owns one audited exact-commit choice. It never starts a builder or app, changes the blocked run, or releases admission. */
export const managedForwardSelection = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "managed forward selection already has an owner");
  // eslint-disable-next-line functional/no-let -- serializes one private decision journal and invalidates uncertain writes
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- an uncertain journal replacement requires reopening
  let poisoned = false;
  const serial = <T>(call: () => Promise<T>) => { const next = pending.then(() => { if (poisoned) throw new Error("managed forward selection is uncertain; reopen"); return call(); }); pending = next.then(() => undefined, () => undefined); return next; };
  const now = () => { const at = ports.now(); if (!Number.isSafeInteger(at) || at < 1) throw new Error("forward selection clock unavailable"); return at; };
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => { const left = Math.min(10_000, deadline - now()); if (left <= 0) return undefined; const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, left);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); } finally { clearTimeout(timer); }
  };
  const load = async () => { const raw = await journal.read(); return raw === undefined ? undefined : parseState(raw); };
  const retained = async (state: ManagedForwardSelection) => {
    const bytes = await bounded(now() + 10_000, () => ports.read(state.source)); if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== state.source) throw new Error("forward selection source unavailable");
    const parsed = source(JSON.parse(bytes)); if (bytes !== JSON.stringify(parsed) || !same(audit(parsed), state.audit)) throw new Error("forward selection source binding disagrees"); return parsed;
  };
  const current = async (value: ManagedForwardSelection["audit"], deadline: number) => { const observed = await bounded(deadline, ports.current); return observed?.status === "held" && observed.checkpoint === value.blocked.checkpoint && same(observed.registration, value.registration); };
  return Object.freeze({
    read: () => serial(load),
    audit: () => serial(async () => { const state = await load(); if (state !== undefined) await retained(state); return state; }),
    select: (input: unknown) => serial(async () => {
      const raw = selectionInput.parse(input); const request = parseManagedForwardSelectionRequest(raw.request); const actor = parseMigrationResolutionActor(raw.actor); if (!request.ok || !actor.ok) throw new Error("invalid managed forward selection request or actor");
      const existing = await load();
      if (existing !== undefined) { if (!same(existing.audit.request, request.value) || !same(existing.audit.actor, actor.value) || raw.createdAt !== undefined && raw.createdAt !== existing.audit.createdAt) throw new Error("forward selection request conflicts"); await retained(existing); return existing; }
      const chosen = managedForwardSelectionInput(raw);
      const at = raw.createdAt ?? now(); if (now() < at || now() >= at + 90_000) throw new Error("forward selection preparation deadline expired"); const planned = managedForwardSelectionIntent(chosen, at); const value = planned.source; const statement = planned.audit;
      if (await bounded(value.preparationDeadline, () => verifyManagedForwardSelectionBaseline(value, ports)) !== true) throw new Error("forward selection baseline evidence unavailable or incompatible");
      if (!await current(statement, value.preparationDeadline) || await bounded(value.preparationDeadline, () => ports.authorize(statement)) !== true) throw new Error("forward selection lacks current operator authority");
      const bytes = JSON.stringify(value); const identity = createHash("sha256").update(bytes).digest("hex"); if (await bounded(value.preparationDeadline, () => ports.retain(bytes)) !== identity || now() >= value.preparationDeadline || !await current(statement, value.preparationDeadline)) throw new Error("forward selection preparation expired or changed");
      if (await bounded(value.preparationDeadline, () => ports.authorize(statement)) !== true || !await current(statement, value.preparationDeadline) || now() >= value.preparationDeadline) throw new Error("forward selection operator authority expired");
      const state = parseState({ version: 1, source: identity, audit: statement, id: hash(statement) });
      try { await journal.write(state); } catch { poisoned = true; throw new Error("managed forward selection is uncertain; reopen"); } return state;
    }),
    buildGrant: () => serial(async () => {
      const state = await load(); if (state === undefined) throw new Error("forward selection intent missing"); await retained(state); const value = state.audit;
      if (now() >= value.buildDeadline || !await current(value, value.buildDeadline) || await bounded(value.buildDeadline, () => ports.authorize(value)) !== true || !await current(value, value.buildDeadline) || now() >= value.buildDeadline) return undefined;
      return Object.freeze({ selection: state.id, owner: value.owner, registration: value.registration, request: value.request.request, blockedRun: value.blocked.run, commit: value.request.commit, deadline: value.buildDeadline });
    }),
  });
};
