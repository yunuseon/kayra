import { err, ok } from "../../lib/result.ts";
import { typed } from "../../lib/typed.ts";

/** The identity is from an immutable admitted plan, not a moving branch. */
export type ReleaseIdentity = { readonly commit: string; readonly planDigest: string };
export type RolloutRequirements = {
  readonly rollbackCompatible: boolean;
  readonly requiredHandoffs: readonly string[];
};
export type ReleaseObservation = {
  readonly operationId: string;
  readonly release: ReleaseIdentity;
  readonly convergence: "unknown" | "passed" | "failed";
  readonly routedReadiness: "unknown" | "passed" | "failed";
  readonly completedHandoffs: readonly string[];
  readonly outcomes: "unknown" | "clear" | "unresolved";
};
export type ReleaseState = {
  readonly legacyHistory: readonly string[];
  readonly phase: "idle" | "deploying" | "rolling-back";
  readonly operationId: string | undefined;
  readonly requested: ReleaseIdentity | undefined;
  readonly desired: ReleaseIdentity | undefined;
  readonly observed: ReleaseObservation | undefined;
  readonly verifiedActive: ReleaseIdentity | undefined;
  readonly lastKnownGood: ReleaseIdentity | undefined;
  readonly rollbackTarget: ReleaseIdentity | undefined;
  readonly activeRequirements: RolloutRequirements | undefined;
  readonly rollbackRequirements: RolloutRequirements | undefined;
  readonly requirements: RolloutRequirements | undefined;
};

const validRelease = (release: ReleaseIdentity) => /^[a-f0-9]{40}$/.test(release.commit) && /^[a-f0-9]{64}$/.test(release.planDigest);
const uuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const same = (left: ReleaseIdentity, right: ReleaseIdentity) => left.commit === right.commit && left.planDigest === right.planDigest;
const names = (items: readonly string[]) => items.every((name) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) && new Set(items).size === items.length;

const immutableRelease = (release: ReleaseIdentity | undefined) => release === undefined ? undefined : Object.freeze({ ...release });
const immutableRequirements = (requirements: RolloutRequirements | undefined) => requirements === undefined ? undefined : Object.freeze({ ...requirements, requiredHandoffs: Object.freeze([...requirements.requiredHandoffs]) });
const snapshot = (state: ReleaseState) => Object.freeze({
  ...state,
  legacyHistory: Object.freeze([...state.legacyHistory]),
  requested: immutableRelease(state.requested),
  desired: immutableRelease(state.desired),
  observed: state.observed === undefined ? undefined : Object.freeze({ ...state.observed, release: Object.freeze({ ...state.observed.release }), completedHandoffs: Object.freeze([...state.observed.completedHandoffs]) }),
  verifiedActive: immutableRelease(state.verifiedActive),
  lastKnownGood: immutableRelease(state.lastKnownGood),
  rollbackTarget: immutableRelease(state.rollbackTarget),
  activeRequirements: immutableRequirements(state.activeRequirements),
  rollbackRequirements: immutableRequirements(state.rollbackRequirements),
  requirements: immutableRequirements(state.requirements),
});

/** Legacy filenames remain readable history, never evidence of a verified active release. */
export const initialReleaseState = (legacyHistory: readonly string[]) => snapshot(typed<ReleaseState>({
  legacyHistory: Object.freeze([...legacyHistory]), phase: "idle", operationId: undefined, requested: undefined, desired: undefined, observed: undefined,
  verifiedActive: undefined, lastKnownGood: undefined, rollbackTarget: undefined, activeRequirements: undefined, rollbackRequirements: undefined, requirements: undefined,
}));

/** The caller supplies requirements from the admitted plan; only one rollout may be pending. */
export const requestRelease = (state: ReleaseState, release: ReleaseIdentity, requirements: RolloutRequirements, operationId: string) => {
  if (state.phase !== "idle") return err("another release is being reconciled");
  if (!uuid(operationId) || operationId === state.operationId || !validRelease(release) || typeof requirements.rollbackCompatible !== "boolean" || !names(requirements.requiredHandoffs)) return err("invalid operation, release or rollout requirements");
  return ok<ReleaseState>(snapshot({
    ...state, phase: "deploying", operationId, requested: { ...release }, desired: { ...release }, observed: undefined,
    rollbackTarget: state.verifiedActive, rollbackRequirements: state.activeRequirements,
    requirements: { rollbackCompatible: requirements.rollbackCompatible, requiredHandoffs: Object.freeze([...requirements.requiredHandoffs]) },
  }));
};

/** Runtime evidence must identify the desired immutable plan. */
export const observeRelease = (state: ReleaseState, observation: ReleaseObservation) => {
  if (state.phase === "idle" || state.desired === undefined || state.requirements === undefined) return err("no rollout to observe");
  if (observation.operationId !== state.operationId || !validRelease(observation.release) || !same(observation.release, state.desired)) return err("observation is for a different release");
  if (!names(observation.completedHandoffs) || observation.completedHandoffs.some((check) => !state.requirements?.requiredHandoffs.includes(check))) return err("unexpected or duplicate handoff evidence");
  if (!["unknown", "passed", "failed"].some((value) => value === observation.convergence) || !["unknown", "passed", "failed"].some((value) => value === observation.routedReadiness) || !["unknown", "clear", "unresolved"].some((value) => value === observation.outcomes)) return err("invalid observation");
  return ok<ReleaseState>(snapshot({ ...state, observed: { ...observation, release: { ...observation.release }, completedHandoffs: Object.freeze([...observation.completedHandoffs]) } }));
};

/** Only verified evidence advances active and last-known-good; effects are not a transaction. */
export const promoteRelease = (state: ReleaseState) => {
  const { desired, observed, requirements } = state;
  if (state.phase === "idle" || desired === undefined || observed === undefined || requirements === undefined) return err("no observed rollout to promote");
  if (observed.operationId !== state.operationId || !same(desired, observed.release) || observed.convergence !== "passed" || observed.routedReadiness !== "passed" || observed.outcomes !== "clear") return err("rollout has not been verified");
  if (requirements.requiredHandoffs.some((check) => !observed.completedHandoffs.includes(check))) return err("required handoff has not completed");
  return ok<ReleaseState>(snapshot({ ...state, phase: "idle", verifiedActive: desired, lastKnownGood: desired, activeRequirements: requirements, rollbackTarget: state.phase === "rolling-back" ? undefined : state.rollbackTarget, rollbackRequirements: state.phase === "rolling-back" ? undefined : state.rollbackRequirements }));
};

/** Rollback changes desired state; the target is not active until it is observed and promoted. */
export const requestRollback = (state: ReleaseState, currentOutcomes: { readonly operationId: string; readonly release: ReleaseIdentity; readonly outcomes: "unknown" | "clear" | "unresolved" }, rollbackOperationId: string) => {
  if (state.phase === "rolling-back") return err("rollback already in progress");
  if (!uuid(rollbackOperationId) || rollbackOperationId === state.operationId) return err("invalid rollback operation identity");
  if (state.rollbackTarget === undefined || state.rollbackRequirements === undefined || state.requirements === undefined) return err("no verified rollback target");
  if (!state.requirements.rollbackCompatible) return err("application did not declare rollback compatibility");
  if (state.desired === undefined || currentOutcomes.operationId !== state.operationId || !validRelease(currentOutcomes.release) || !same(currentOutcomes.release, state.desired)) return err("outcome evidence is for a different release");
  if (state.observed?.outcomes !== "clear" || currentOutcomes.outcomes !== "clear") return err("rollback is blocked by unresolved outcomes");
  return ok<ReleaseState>(snapshot({ ...state, phase: "rolling-back", operationId: rollbackOperationId, desired: state.rollbackTarget, requirements: state.rollbackRequirements, observed: undefined }));
};
