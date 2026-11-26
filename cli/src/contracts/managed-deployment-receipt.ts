import { z } from "zod";
import { names } from "../lib/names.ts";
import { err, ok } from "../lib/result.ts";

const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({ version: z.literal(3), protocol: z.literal("managed-v3"), app: z.string().regex(names.app.pattern), request: z.uuid(), commit: z.string().regex(/^[a-f0-9]{40}$/),
  plan: z.string().regex(/^[a-f0-9]{64}$/), createdAt: time, admissionDeadline: time, deadline: time,
  phase: z.enum(["accepted", "complete"]), outcome: z.enum(["deployed", "rolled-back", "absent", "unchanged", "superseded"]).nullable(), disposition: z.enum(["success", "failure", "cancelled"]).nullable(),
}).strict().readonly().refine((value) => value.admissionDeadline === value.createdAt + 90_000 && value.deadline > value.admissionDeadline &&
  (value.outcome !== "superseded" || value.disposition === "failure") &&
  (value.phase === "complete" ? value.outcome !== null && value.disposition !== null && (value.disposition === "success") === (value.outcome === "deployed") : value.outcome === null && value.disposition === null));

/** Acceptance is durable intent, not native convergence or release promotion. Detailed live phase remains in the deployment status projection. */
export const parseManagedDeploymentReceipt = (input: unknown) => {
  const parsed = schema.safeParse(input); return parsed.success ? ok(parsed.data) : err("invalid managed deployment receipt");
};
export type ManagedDeploymentReceipt = Extract<ReturnType<typeof parseManagedDeploymentReceipt>, { readonly ok: true }>["value"];
