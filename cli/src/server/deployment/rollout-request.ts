import { z } from "zod";
import { parseRolloutPreparation } from "./rollout-preparation.ts";

const schema = z.object({ ticket: z.string().max(80), action: z.string().max(80), commit: z.string().regex(/^[0-9a-f]{40}$/),
  admissionDeadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), admitted: z.boolean(), preparation: z.unknown(),
  completion: z.object({ kind: z.literal("unstarted"), outcome: z.enum(["cancelled", "failed"]), reason: z.enum(["cancelled", "deadline"]),
    at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), previous: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  }).strict().readonly().optional(),
}).strict().readonly();

/** The lifecycle envelope authenticates the ticket and action; this parser checks its private phase. */
export const parseRolloutRequest = (input: unknown) => {
  const checked = schema.safeParse(input); if (!checked.success) throw new Error("invalid rollout request");
  const { completion, ...request } = checked.data; const preparation = parseRolloutPreparation(request.preparation);
  if (request.admissionDeadline !== preparation.createdAt + 90_000 || !request.admitted && preparation.phase !== "prepared") throw new Error("rollout preparation lacks admission");
  if (completion !== undefined && (preparation.phase !== "prepared" || preparation.sequence !== null || completion.at < preparation.createdAt ||
    (completion.outcome === "cancelled") !== (completion.reason === "cancelled") || completion.outcome === "failed" && (request.admitted || completion.at < request.admissionDeadline))) throw new Error("rollout completion lacks unstarted intent proof");
  return Object.freeze({ ...request, preparation, ...(completion === undefined ? {} : { completion }) });
};
