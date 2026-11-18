import { createHash } from "node:crypto";
import { z } from "zod";
import { parseDataOwnership } from "../../contracts/owned-volume.ts";
import { parseManagedMaintenanceQuiescence } from "./managed-maintenance-quiescence.ts";
import { parseManagedGroupPreparation } from "./managed-group-preparation.ts";
import { parseManagedConsumerState } from "./managed-consumer-state.ts";
import { parseManagedGroupVerification } from "./managed-group-verification.ts";
import { parseMigrationResolutionReceipt } from "../../contracts/migration-resolution.ts";
import { parseManagedGroupCompensation } from "./managed-group-compensation.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pointer = z.object({ record: digest, plan: digest, run: z.uuid(), verifiedAt: positive, epoch }).strict().readonly();
const phase = z.enum(["admitting", "allocating", "quiescing", "preparing", "updating", "verifying", "recovering", "recovery-verifying", "settling", "complete", "held"]);
const reason = z.enum(["admission", "allocation", "deadline", "authorization", "quiescence", "preparation", "consumers", "verification", "recovery", "recovery-verification", "cancellation"]);
const schema = z.object({ version: z.literal(3), protocol: z.literal("managed-v3"), runtime: z.literal("swarm"), owner: z.unknown(), sequence: positive, compatibilityEpoch: epoch,
  active: pointer.nullable(), lastGood: pointer.nullable(), history: digest.nullable(),
  operation: z.object({ run: z.uuid(), action: z.string().max(80), source: digest, plan: digest, previous: digest.nullable(), previousPlan: digest.nullable(), createdAt: positive, admissionDeadline: positive, deadline: positive,
    allocation: z.object({ createdAt: positive, deadline: positive, readyAt: positive.nullable() }).strict().readonly().optional(),
    phase, enteredAt: positive, reason: reason.nullable(),
    outcome: z.enum(["deployed", "rolled-back", "absent", "unchanged"]).nullable(), settlement: z.enum(["target", "previous", "absent"]).nullable(),
    unstartedAt: positive.nullable().default(null),
    failure: z.object({ reason, at: positive }).strict().readonly().nullable(),
    admitted: z.boolean(), settled: z.boolean(), cancelRequestedAt: positive.nullable(), compatibilityEpoch: epoch, compatibilityFencedAt: positive.nullable(), resolutionReceipts: z.array(z.unknown()).max(128).readonly().default([]),
    quiescence: z.unknown().nullable(), preparation: z.unknown().nullable(), consumers: z.unknown().nullable(), verification: z.unknown().nullable(),
    recoverySource: digest.nullable(), recoveryStartedAt: positive.nullable(), recoveryDeadline: positive.nullable(), recovery: z.unknown().nullable(), recoveryVerification: z.unknown().nullable(),
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
  const recovery = operation.recovery === null ? null : parseManagedGroupCompensation(operation.recovery);
  const recoveryVerification = operation.recoveryVerification === null ? null : parseManagedGroupVerification(operation.recoveryVerification);
  if (operation.allocation !== undefined && (operation.allocation.deadline !== operation.allocation.createdAt + 90_000 || operation.allocation.createdAt < operation.createdAt || operation.allocation.deadline > operation.deadline || operation.allocation.readyAt !== null && (operation.allocation.readyAt < operation.allocation.createdAt || operation.allocation.readyAt >= operation.allocation.deadline)) || operation.allocation?.readyAt === null && (["quiescing", "preparing", "updating", "verifying", "recovering", "recovery-verifying"].includes(operation.phase) || quiescence !== null || preparation !== null || consumers !== null || verification !== null || recovery !== null || recoveryVerification !== null) || operation.phase === "allocating" && (operation.allocation?.readyAt !== null || operation.enteredAt !== operation.allocation.createdAt || !operation.admitted) ||
    (operation.previous === null) !== (operation.previousPlan === null) || (operation.recoverySource === null) !== (operation.recoveryStartedAt === null) || (operation.recoverySource === null) !== (operation.recoveryDeadline === null) || (operation.recoverySource === null && operation.unstartedAt === null) !== (operation.failure === null) || operation.failure !== null && operation.failure.at !== (operation.unstartedAt ?? operation.recoveryStartedAt) ||
    operation.recoveryStartedAt !== null && (operation.recoveryStartedAt < operation.createdAt || operation.recoveryDeadline !== operation.recoveryStartedAt + 90_000 || operation.recoveryDeadline > operation.deadline || operation.failure === null || preparation === null && (quiescence === null || operation.previousPlan === null || consumers !== null || verification !== null)) ||
    recovery !== null && (recovery.source !== operation.recoverySource || recovery.plan !== operation.plan || recovery.previous !== operation.previousPlan || recovery.run !== operation.run || recovery.action !== operation.action || recovery.createdAt !== operation.recoveryStartedAt || recovery.deadline !== operation.recoveryDeadline || recovery.app !== owner.value.app || recovery.incarnation !== owner.value.incarnation || recovery.dataOwner !== owner.value.dataOwner) ||
    recoveryVerification !== null && (recovery?.phase !== "verified" || recoveryVerification.plan !== operation.previousPlan || recoveryVerification.run !== operation.run || recoveryVerification.deadline > operation.deadline || recoveryVerification.app !== owner.value.app || recoveryVerification.incarnation !== owner.value.incarnation || recoveryVerification.dataOwner !== owner.value.dataOwner) ||
    operation.phase === "recovering" && operation.recoverySource === null || operation.phase === "recovery-verifying" && recovery?.phase !== "verified" ||
    (operation.outcome === null) !== (operation.settlement === null) || operation.outcome !== null && !["settling", "complete"].includes(operation.phase) || ["settling", "complete"].includes(operation.phase) && operation.outcome === null ||
    operation.outcome === "deployed" && (operation.settlement !== "target" || verification?.phase !== "verified" || raw.active?.plan !== operation.plan || raw.active.run !== operation.run || raw.active.verifiedAt !== verification.verified?.at) ||
    operation.outcome === "rolled-back" && (operation.settlement !== "previous" || recoveryVerification?.phase !== "verified" || raw.active?.plan !== operation.previousPlan || raw.active.run !== operation.run || raw.active.verifiedAt !== recoveryVerification.verified?.at || operation.failure === null) ||
    operation.outcome === "absent" && (operation.settlement !== "absent" || (operation.unstartedAt === null && recovery?.phase !== "verified") || operation.previousPlan !== null || raw.active !== null || operation.failure === null) ||
    operation.outcome === "unchanged" && (operation.unstartedAt === null || operation.settlement !== "previous" || operation.previous === null || raw.active?.record !== operation.previous || raw.active.plan !== operation.previousPlan) ||
    operation.unstartedAt !== null && (operation.unstartedAt < operation.createdAt || operation.recoverySource !== null || operation.compatibilityFencedAt !== null || preparation !== null || consumers !== null || verification !== null || recovery !== null || recoveryVerification !== null || quiescence !== null && quiescence.nodes.length !== 0 || operation.outcome !== (operation.previous === null ? "absent" : "unchanged")) ||
    operation.outcome !== null && operation.outcome !== "absent" && !same(raw.active, raw.lastGood)) throw new Error("inconsistent managed recovery outcome");
  const resolutionReceipts = Object.freeze(operation.resolutionReceipts.map((raw) => { const receipt = parseMigrationResolutionReceipt(raw); if (!receipt.ok) throw new Error("invalid managed migration resolution receipt"); return receipt.value; }));
  if (new Set(resolutionReceipts.map((receipt) => receipt.step)).size !== resolutionReceipts.length || resolutionReceipts.some((receipt) => {
    const audit = preparation?.sequence?.steps.find((step) => step.id === receipt.step)?.resolution;
    return audit === undefined || receipt.app !== owner.value.app || receipt.run !== operation.run || receipt.resolution !== audit.id || receipt.outcome !== audit.outcome || receipt.recordedAt !== audit.at || receipt.disposition === "cancelled" || receipt.disposition === "continue" && (audit.outcome !== "applied" || audit.at >= (preparation?.sequence?.deadline ?? 0) || audit.at >= operation.deadline);
  }) || preparation?.sequence?.steps.some((step) => step.resolution !== undefined && !resolutionReceipts.some((receipt) => receipt.resolution === step.resolution?.id))) throw new Error("managed migration resolution receipt disagrees");
  if (operation.compatibilityEpoch !== raw.compatibilityEpoch || [raw.active, raw.lastGood].some((value) => value !== null && value.epoch > raw.compatibilityEpoch) || operation.compatibilityFencedAt !== null && (raw.compatibilityEpoch < 1 || operation.compatibilityFencedAt < operation.createdAt || operation.compatibilityFencedAt >= operation.deadline) ||
    operation.action !== `${owner.value.incarnation}:${String(raw.sequence)}` || operation.admissionDeadline !== operation.createdAt + 90_000 || operation.deadline <= operation.admissionDeadline || operation.enteredAt < operation.createdAt ||
    operation.cancelRequestedAt !== null && operation.cancelRequestedAt < operation.createdAt || (operation.phase === "held") !== (operation.reason !== null) || operation.settled && operation.phase !== "complete" || operation.phase === "complete" && !operation.settled ||
    [quiescence, preparation, consumers, verification].some((child) => child !== null && (child.app !== owner.value.app || child.incarnation !== owner.value.incarnation || child.dataOwner !== owner.value.dataOwner || child.run !== operation.run || child.plan !== operation.plan)) ||
    quiescence !== null && (quiescence.action !== operation.action || quiescence.createdAt < operation.createdAt || quiescence.deadline > operation.deadline) ||
    preparation !== null && (preparation.action !== operation.action || preparation.createdAt < operation.createdAt || preparation.migrationDeadline > operation.deadline) ||
    consumers !== null && (preparation?.phase !== "ready" || consumers.action !== operation.action || consumers.deadline !== preparation.consumerDeadline || consumers.preparation !== hash(JSON.stringify(preparation))) ||
    verification !== null && (consumers?.phase !== "ready" || verification.deadline > operation.deadline) ||
    ["allocating", "quiescing", "preparing", "updating", "verifying", "recovering", "recovery-verifying", "settling", "complete"].includes(operation.phase) && !operation.admitted && operation.unstartedAt === null ||
    ["updating", "verifying"].includes(operation.phase) && preparation?.phase !== "ready" ||
    operation.phase === "verifying" && consumers?.phase !== "ready") throw new Error("inconsistent managed lifecycle store");
  const { allocation, ...original } = operation;
  return Object.freeze({ ...raw, owner: owner.value, operation: Object.freeze({ ...original, ...(allocation === undefined ? {} : { allocation }), resolutionReceipts, quiescence, preparation, consumers, verification, recovery, recoveryVerification }) });
};
export type ManagedLifecycleStore = ReturnType<typeof parseManagedLifecycleStore>;
