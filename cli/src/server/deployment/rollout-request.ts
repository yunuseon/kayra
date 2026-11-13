import { z } from "zod";
import { migrationAttemptBarrier } from "./migration-sequence.ts";
import { parseRolloutPreparation } from "./rollout-preparation.ts";

const schema = z.object({ ticket: z.string().max(80), action: z.string().max(80), commit: z.string().regex(/^[0-9a-f]{40}$/),
  admissionDeadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), admitted: z.boolean(), preparation: z.unknown(),
  completion: z.discriminatedUnion("kind", [z.object({ kind: z.literal("unstarted"), outcome: z.enum(["cancelled", "failed"]), reason: z.enum(["cancelled", "deadline"]),
    at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), previous: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  }).strict().readonly(), z.object({ kind: z.literal("migration-resolved"), outcome: z.literal("failed"), reason: z.enum(["migration", "deadline"]),
    at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), previous: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    resolution: z.string().regex(/^[0-9a-f]{64}$/), step: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  }).strict().readonly()]).optional(),
}).strict().readonly();

/** The lifecycle envelope authenticates the ticket and action; this parser checks its private phase. */
export const parseRolloutRequest = (input: unknown) => {
  const checked = schema.safeParse(input); if (!checked.success) throw new Error("invalid rollout request");
  const { completion, ...request } = checked.data; const preparation = parseRolloutPreparation(request.preparation);
  if (request.admissionDeadline !== preparation.createdAt + 90_000 || !request.admitted && preparation.phase !== "prepared") throw new Error("rollout preparation lacks admission");
  if (completion?.kind === "unstarted" && (preparation.phase !== "prepared" || preparation.sequence !== null || completion.at < preparation.createdAt ||
    (completion.outcome === "cancelled") !== (completion.reason === "cancelled") || completion.outcome === "failed" && (request.admitted || completion.at < request.admissionDeadline))) throw new Error("rollout completion lacks unstarted intent proof");
  if (completion?.kind === "migration-resolved") {
    const step = preparation.sequence?.steps.find((step) => step.id === completion.step); const resolution = step?.resolution;
    if (!request.admitted || preparation.phase !== "held" || preparation.httpDeadline !== null || preparation.sequence?.phase !== "held" || preparation.sequence.steps[preparation.sequence.position]?.id !== completion.step ||
      resolution?.id !== completion.resolution || resolution.at !== completion.at ||
      (completion.reason === "migration" ? resolution.outcome !== "not-applied" : resolution.outcome !== "applied" || resolution.at < preparation.migrationDeadline) ||
      preparation.sequence.steps.some((item) => item.attempts.some((attempt) => migrationAttemptBarrier(attempt) === null))) throw new Error("resolved rollout completion lacks fenced outcome proof");
  }
  return Object.freeze({ ...request, preparation, ...(completion === undefined ? {} : { completion }) });
};
