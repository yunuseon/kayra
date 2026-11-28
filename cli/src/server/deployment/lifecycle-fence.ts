/* Schema parsing creates mutable temporary objects before freezing. */
/* eslint-disable functional/prefer-immutable-types, functional/type-declaration-immutability */
import { z } from "zod";
import { err, ok } from "../../lib/result.ts";

/* Disconnected state machine: it does not lock, persist, authenticate evidence,
 * inspect Docker or stop old writers. A single trusted owner must persist each
 * transition before effects and reconcile effects before completing them. A
 * deadline, lost client, missing registration or process restart is not evidence
 * of completion. Generation IDs must never be reused, including across purges. */
const name = z.string().regex(/^[a-z][a-z0-9-]*$/);
const generation = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const sequence = z.number().int().positive();
const volume = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).max(255);
const volumes = z.array(volume).max(128).refine((items) => new Set(items).size === items.length);
const action = z.object({ sequence, kind: z.enum(["register", "deploy", "restore", "remove", "purge"]) }).strict();
const tombstone = z.object({ removal: sequence, volumes }).strict();
const lifecycle = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("registering"), active: action }).strict(),
  z.object({ phase: z.literal("registered"), active: action.nullable() }).strict(),
  z.object({ phase: z.literal("removal-requested"), active: action.nullable(), removal: sequence }).strict(),
  z.object({ phase: z.literal("removing"), removal: sequence, volumes }).strict(),
  z.object({ phase: z.literal("removed"), tombstone }).strict(),
  z.object({ phase: z.literal("purging"), tombstone, purge: sequence }).strict(),
  z.object({ phase: z.literal("purged"), tombstone, purge: sequence }).strict(),
]);
const schema = z.object({ version: z.literal(1), app: name, generation, nextAction: sequence, lifecycle }).strict().superRefine((value, ctx) => {
  const state = value.lifecycle;
  const invalid = () => { ctx.addIssue({ code: "custom", message: "invalid lifecycle invariant" }); };
  const validSequence = (n: number) => n < value.nextAction;
  if (state.phase === "registering" && (state.active.kind !== "register" || !validSequence(state.active.sequence))) invalid();
  if (state.phase === "registered" && state.active !== null && (!["register", "deploy", "restore"].includes(state.active.kind) || !validSequence(state.active.sequence))) invalid();
  if (state.phase === "removal-requested" && (!validSequence(state.removal) || (state.active !== null && (!["register", "deploy", "restore"].includes(state.active.kind) || state.active.sequence >= state.removal)))) invalid();
  if (state.phase === "removing" && !validSequence(state.removal)) invalid();
  if (state.phase === "removed" && !validSequence(state.tombstone.removal)) invalid();
  if ((state.phase === "purging" || state.phase === "purged") && (!validSequence(state.purge) || state.tombstone.removal >= state.purge)) invalid();
});
export type LifecycleFence = z.infer<typeof schema>;

const freeze = (value: LifecycleFence): LifecycleFence => {
  const state = value.lifecycle;
  if ("active" in state && state.active !== null) Object.freeze(state.active);
  if ("volumes" in state) Object.freeze(state.volumes);
  if ("tombstone" in state) { Object.freeze(state.tombstone.volumes); Object.freeze(state.tombstone); }
  Object.freeze(state);
  return Object.freeze(value);
};
/** Parse persisted input on every read; malformed or contradictory states fail closed. */
export const parseLifecycleFence = (input: unknown) => {
  const result = schema.safeParse(input);
  return result.success ? ok(freeze(result.data)) : err("invalid lifecycle fence");
};
const transition = (input: unknown, apply: (state: LifecycleFence) => unknown) => {
  const before = parseLifecycleFence(input);
  if (!before.ok) return before;
  return parseLifecycleFence(apply(before.value));
};
const allocate = (state: LifecycleFence) => state.nextAction < Number.MAX_SAFE_INTEGER ? state.nextAction : undefined;
/** This creates an unverified registration intent, never an inferred registered app. */
export const beginRegistration = (app: string, id: string) => parseLifecycleFence({
  version: 1, app, generation: id, nextAction: 2,
  lifecycle: { phase: "registering", active: { sequence: 1, kind: "register" } },
});
/** IDs are stable across restart and cannot repeat inside a generation. */
export const lifecycleActionId = (state: LifecycleFence, actionSequence: number) => `${state.generation}:${String(actionSequence)}`;

export const beginLifecycleWork = (input: unknown, kind: "deploy" | "restore") => transition(input, (state) => {
  const next = allocate(state);
  if (state.lifecycle.phase !== "registered" || state.lifecycle.active !== null || next === undefined || !["deploy", "restore"].includes(kind)) return undefined;
  return { ...state, nextAction: next + 1, lifecycle: { phase: "registered", active: { kind, sequence: next } } };
});
/** Existing registration updates use the same durable fence as deployment work. */
export const beginLifecycleRegistration = (input: unknown) => transition(input, (state) => {
  const next = allocate(state);
  if (state.lifecycle.phase !== "registered" || state.lifecycle.active !== null || next === undefined) return undefined;
  return { ...state, nextAction: next + 1, lifecycle: { phase: "registered", active: { kind: "register", sequence: next } } };
});
/** Completion means a trusted reconciler established the outcome; identity alone is not evidence.
 * For registration, the owner must establish successful registration before settling. */
export const settleLifecycleWork = (input: unknown, actionId: string) => transition(input, (state) => {
  const current = state.lifecycle;
  if (!(current.phase === "registering" || current.phase === "registered" || current.phase === "removal-requested") || current.active === null || lifecycleActionId(state, current.active.sequence) !== actionId) return undefined;
  if (current.phase === "removal-requested") return { ...state, lifecycle: { ...current, active: null } };
  return { ...state, lifecycle: { phase: "registered", active: null } };
});
/** Records the removal fence even when a prior action still needs reconciliation. */
export const requestLifecycleRemoval = (input: unknown) => transition(input, (state) => {
  const current = state.lifecycle;
  const next = allocate(state);
  if (!(current.phase === "registering" || current.phase === "registered") || next === undefined) return undefined;
  return { ...state, nextAction: next + 1, lifecycle: { phase: "removal-requested", active: current.active, removal: next } };
});
/** Capture trusted complete ownership after prior work settles, while the fence is held. */
export const startLifecycleRemoval = (input: unknown, ownedVolumes: readonly string[]) => transition(input, (state) => {
  const current = state.lifecycle;
  if (current.phase !== "removal-requested" || current.active !== null) return undefined;
  return { ...state, lifecycle: { phase: "removing", removal: current.removal, volumes: ownedVolumes } };
});
/** Caller must establish that all owned workloads were removed before this transition. */
export const completeLifecycleRemoval = (input: unknown, actionId: string) => transition(input, (state) => {
  const current = state.lifecycle;
  if (current.phase !== "removing" || lifecycleActionId(state, current.removal) !== actionId) return undefined;
  return { ...state, lifecycle: { phase: "removed", tombstone: { removal: current.removal, volumes: current.volumes } } };
});
/** Purge effects additionally require live ownership and attachment checks under the same fence. */
export const startLifecyclePurge = (input: unknown, removalId: string) => transition(input, (state) => {
  const current = state.lifecycle;
  const next = allocate(state);
  if (current.phase !== "removed" || lifecycleActionId(state, current.tombstone.removal) !== removalId || next === undefined) return undefined;
  return { ...state, nextAction: next + 1, lifecycle: { phase: "purging", tombstone: current.tombstone, purge: next } };
});
/** Caller must establish the outcome of the specific purge before completing it. */
export const completeLifecyclePurge = (input: unknown, actionId: string) => transition(input, (state) => {
  const current = state.lifecycle;
  if (current.phase !== "purging" || lifecycleActionId(state, current.purge) !== actionId) return undefined;
  return { ...state, lifecycle: { ...current, phase: "purged" } };
});
