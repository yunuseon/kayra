import { createHash } from "node:crypto";
import type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { parseDataOwnership } from "../../contracts/owned-volume.ts";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({ version: z.literal(1), protocol: z.literal("managed-v3"), owner: z.unknown(), run: z.uuid(), ticket: z.string().max(80), action: z.string().max(80), source: digest, plan: digest,
  createdAt: positive, admissionDeadline: positive, deadline: positive,
  completion: z.union([
    z.object({ rootSnapshot: digest, outcome: z.enum(["deployed", "rolled-back", "absent", "unchanged"]), disposition: z.enum(["success", "failure", "cancelled"]) }).strict().readonly(),
    z.object({ rootSnapshot: digest, outcome: z.literal("superseded"), disposition: z.literal("failure"), successor: z.uuid() }).strict().readonly(),
  ]).nullable(),
}).strict().readonly();
/** Private references only. The indexed writer authenticates the retained source and root snapshot; this record never authorizes runtime effects. */
export const parseManagedLifecycleRequest = (input: unknown) => {
  const value = schema.parse(input);
  const owner = parseDataOwnership(value.owner); if (!owner.ok || !new RegExp(`^${owner.value.incarnation}:[1-9][0-9]*$`).test(value.action) || !Number.isSafeInteger(Number(value.action.split(":")[1]))) throw new Error("invalid managed lifecycle request ownership");
  if (value.admissionDeadline !== value.createdAt + 90_000 || value.deadline <= value.admissionDeadline || value.completion?.outcome === "superseded" && value.completion.successor === value.run || value.completion !== null && (value.completion.disposition === "success") !== (value.completion.outcome === "deployed")) throw new Error("inconsistent managed lifecycle request");
  return Object.freeze({ ...value, owner: owner.value });
};
export type ManagedLifecycleRequest = ReturnType<typeof parseManagedLifecycleRequest>;


/** Older outcomes require a fully settled terminal root. Supersession preserves its held snapshot. */
export const matchesManagedRequestCompletion = (completion: NonNullable<ManagedLifecycleRequest["completion"]>, state: ManagedLifecycleStore) => {
  if (createHash("sha256").update(JSON.stringify(state)).digest("hex") !== completion.rootSnapshot) return false;
  const operation = state.operation;
  return completion.outcome === "superseded"
    ? operation.phase === "held" && operation.admitted && !operation.settled
    : operation.phase === "complete" && operation.settled && operation.outcome === completion.outcome;
};
