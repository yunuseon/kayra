import { managedForwardEffectSource, managedForwardEffectSourceDigest } from "./managed-forward-effect-source.ts";
import { createHash } from "node:crypto";
import { parseManagedApplicationPlan, managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { parseLifecycleEnvelope } from "./lifecycle-envelope.ts";
import { lifecycleActionId, parseLifecycleFence } from "./lifecycle-fence.ts";
import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { managedLifecycleDescription, parseManagedLifecycleSource, managedLifecycleSourceDigest } from "./managed-lifecycle-source.ts";
import { managedForwardRecoveryBaseline } from "./managed-forward-recovery-proposal.ts";
import { managedForwardReservation } from "./managed-forward-reservation.ts";
import type { ManagedForwardReservation } from "./managed-forward-reservation.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Input = { readonly candidate: ManagedApplicationPlan; readonly baseline: { readonly state: unknown; readonly source: unknown }; readonly selection: ManagedForwardReservation["selection"]; readonly build: ManagedForwardReservation["build"]; readonly createdAt: number; readonly operator: ManagedForwardReservation["operator"] };

/** The owning index authenticates the selected build and current operator purpose before persisting this transition. No effects. */
export const reserveManagedForwardEnvelope = (before: unknown, input: Input) => {
  const parsed = parseLifecycleEnvelope(before); if (!parsed.ok) throw new Error(parsed.error); const current = parsed.value;
  const candidate = parseManagedApplicationPlan(input.candidate); if (!candidate.ok) throw new Error("invalid forward reservation candidate");
  const state = parseManagedLifecycleStore(input.baseline.state); const description = managedLifecycleDescription(parseManagedLifecycleSource(input.baseline.source)); const source = description.source;
  const blocked = Object.freeze({ run: state.operation.run, source: state.operation.source, checkpoint: hash(state), compatibilityEpoch: state.compatibilityEpoch });
  const existing = current.forward;
  if (existing !== undefined) {
    if (!same(existing.blocked, blocked) || !same(existing.selection, input.selection) || !same(existing.build, input.build) || existing.candidate !== managedApplicationDigest(candidate.value) || !same(existing.operator, input.operator)) throw new Error("managed forward reservation conflicts");
    return Object.freeze({ state: current, reservation: existing, changed: false });
  }
  const fence = current.fence; const active = fence?.lifecycle; const pending = current.managed?.find((item) => item.run === blocked.run);
  if (fence === null || active?.phase !== "registered" || active.active === null || !["deploy", "restore"].includes(active.active.kind) || fence.nextAction >= Number.MAX_SAFE_INTEGER || pending?.completion !== null ||
    pending.source !== managedLifecycleSourceDigest(source) || pending.action !== source.action || lifecycleActionId(fence, active.active.sequence) !== source.action || source.run !== state.operation.run || source.action !== state.operation.action || source.createdAt !== state.operation.createdAt || description.admissionDeadline !== state.operation.admissionDeadline || !same(state.owner, source.candidate.infrastructure.ownership) || state.operation.previousPlan !== (description.admission.previous === null ? null : managedApplicationDigest(description.admission.previous)) || description.admission.planDigest !== state.operation.plan || description.previous !== state.operation.previous || description.deadline !== state.operation.deadline ||
    state.operation.source !== pending.source || !same(pending.owner, state.owner) || current.registrationReceipt?.runtime !== "swarm" || !same(current.registrationReceipt.metadata, input.build.registration) || !same(candidate.value.infrastructure.registration, input.build.registration) || candidate.value.commit !== input.build.commit || candidate.value.artifact !== input.build.artifact || input.createdAt < state.operation.enteredAt) throw new Error("managed forward reservation lacks its owned held lifecycle and prepared candidate");
  const action = lifecycleActionId(fence, fence.nextAction);
  managedForwardRecoveryBaseline(state, source, candidate.value, { run: input.selection.request, action, createdAt: input.createdAt, reason: input.operator.reason });
  const reservation = managedForwardReservation({ version: 1, phase: "initializing", owner: state.owner, run: input.selection.request, action, createdAt: input.createdAt, deadline: input.createdAt + 90_000, blocked, selection: input.selection, build: input.build, operator: input.operator, candidate: managedApplicationDigest(candidate.value) });
  const reserved = parseLifecycleFence({ ...fence, nextAction: fence.nextAction + 1 }); if (!reserved.ok) throw new Error(reserved.error);
  const next = parseLifecycleEnvelope({ ...current, fence: reserved.value, forward: reservation }); if (!next.ok) throw new Error(next.error);
  return Object.freeze({ state: next.value, reservation, changed: true });
};

/** Publish only a source prepared under the reserved action and original phase clock. The caller synchronizes its private child journal first. */
export const publishManagedForwardCleanup = (before: unknown, expected: ManagedForwardReservation, sourceInput: unknown) => {
  const parsed = parseLifecycleEnvelope(before); if (!parsed.ok) throw new Error(parsed.error); const current = parsed.value;
  const source = managedForwardEffectSource(sourceInput); const reservation = current.forward;
  if (reservation?.phase !== "initializing" || !same(reservation, expected) || source.request.run !== reservation.run || source.request.action !== reservation.action || source.request.createdAt !== reservation.createdAt || source.request.reason !== reservation.operator.reason || source.deadline !== reservation.deadline || source.decision !== reservation.selection.decision ||
    hash(source.baseline.state) !== reservation.blocked.checkpoint || source.baseline.state.operation.source !== reservation.blocked.source || source.candidate.commit !== reservation.build.commit || source.candidate.artifact !== reservation.build.artifact || !same(source.candidate.infrastructure.registration, reservation.build.registration)) throw new Error("managed forward cleanup publication conflicts with its reserved intent");
  const next = parseLifecycleEnvelope({ ...current, forward: { ...reservation, phase: "fencing", cleanup: managedForwardEffectSourceDigest(source) } }); if (!next.ok || next.value.forward === undefined) throw new Error("managed forward cleanup publication is invalid");
  return Object.freeze({ state: next.value, reservation: next.value.forward });
};

/** Initialization expiry is durable metadata, never evidence of absent workloads or free capacity. */
export const holdManagedForwardInitialization = (before: unknown, expected: ManagedForwardReservation, at: number) => {
  const parsed = parseLifecycleEnvelope(before); if (!parsed.ok) throw new Error(parsed.error); const current = parsed.value;
  if (current.forward?.phase !== "initializing" || !same(current.forward, expected) || !Number.isSafeInteger(at) || at < expected.deadline) throw new Error("forward initialization hold conflicts");
  const next = parseLifecycleEnvelope({ ...current, forward: { ...current.forward, phase: "held", reason: "deadline", heldAt: at } }); if (!next.ok || next.value.forward === undefined) throw new Error("invalid held forward initialization");
  return Object.freeze({ state: next.value, reservation: next.value.forward });
};

/** Record the one successor source eligible for the pending charge transfer. No capacity is written here. */
export const publishManagedForwardHandoff = (before: unknown, expected: ManagedForwardReservation, input: unknown) => {
  const parsed = parseLifecycleEnvelope(before);
  if (!parsed.ok) throw new Error(parsed.error);
  const current = parsed.value;
  const reservation = current.forward;
  const source = parseManagedLifecycleSource(input);
  const certificate = source.forward;
  if (reservation?.phase !== "fencing" || !same(reservation, expected) || source.version !== 3 || certificate === undefined ||
    source.run !== reservation.run || source.action !== reservation.action || source.candidate.commit !== reservation.build.commit ||
    source.candidate.artifact !== reservation.build.artifact || !same(source.candidate.infrastructure.registration, reservation.build.registration) ||
    certificate.reservation !== hash(reservation) || certificate.cleanupSource !== reservation.cleanup || certificate.decision !== reservation.selection.decision ||
    certificate.blocked.run !== reservation.blocked.run || certificate.blocked.source !== reservation.blocked.source ||
    certificate.blocked.checkpoint !== reservation.blocked.checkpoint || certificate.blocked.epoch !== reservation.blocked.compatibilityEpoch ||
    !current.managed?.some((item) => item.run === certificate.blocked.run && item.action === certificate.blocked.action && item.completion === null)) {
    throw new Error("managed handoff source conflicts with its reservation");
  }
  const next = parseLifecycleEnvelope({ ...current, forward: {
    ...reservation, phase: "transferring",
    handoff: { source: managedLifecycleSourceDigest(source), cleanupState: certificate.cleanupState, createdAt: source.createdAt, deadline: source.createdAt + 90_000 },
  } });
  if (!next.ok || next.value.forward?.phase !== "transferring") throw new Error("invalid managed admission handoff");
  return Object.freeze({ state: next.value, reservation: next.value.forward });
};
