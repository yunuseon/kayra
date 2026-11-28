import { z } from "zod";
import { ownedVolumeSchema, volumeReceiptSchema } from "../../contracts/owned-volume.ts";
import { migrationReasonSchema, parseMigrationResolutionActor } from "../../contracts/migration-resolution.ts";

const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const identity = z.string().max(80).regex(/^[0-9a-f-]{36}:[1-9][0-9]*$/);
const schema = z.object({
  version: z.literal(1), request: z.uuid(), ticket: identity, action: identity, removal: z.uuid(),
  createdAt: time, deadline: time, finishedAt: time.nullable(),
  phase: z.enum(["preflight", "deleting", "held", "complete"]),
  reason: z.enum(["deadline", "registration", "attachments", "ownership"]).nullable(),
  operator: z.object({ actor: z.unknown(), reason: migrationReasonSchema }).strict().readonly(),
  entries: z.array(z.object({
    volume: ownedVolumeSchema, birth: volumeReceiptSchema.nullable(),
    phase: z.enum(["pending", "deleting", "absent"]),
  }).strict().readonly()).max(32).readonly(),
}).strict().readonly();

export const parseManagedPurge = (input: unknown) => {
  const state = schema.parse(input);
  const actor = parseMigrationResolutionActor(state.operator.actor);
  if (!actor.ok || state.request === state.removal || state.deadline !== state.createdAt + 90_000 ||
    (state.phase === "held") !== (state.reason !== null) || (state.phase === "complete") !== (state.finishedAt !== null) ||
    state.finishedAt !== null && (state.finishedAt < state.createdAt || state.finishedAt >= state.deadline) ||
    new Set(state.entries.map((entry) => entry.volume.allocation)).size !== state.entries.length ||
    state.entries.filter((entry) => entry.phase === "deleting").length > 1 ||
    state.entries.some((entry) => entry.birth !== null && JSON.stringify(entry.birth.volume) !== JSON.stringify(entry.volume) ||
      entry.birth === null && entry.phase === "deleting" || state.phase === "preflight" && entry.phase !== "pending" ||
      state.phase === "complete" && entry.phase !== "absent")) throw new Error("inconsistent managed purge state");
  return Object.freeze({ ...state, operator: Object.freeze({ ...state.operator, actor: actor.value }) });
};
export type ManagedPurge = ReturnType<typeof parseManagedPurge>;
