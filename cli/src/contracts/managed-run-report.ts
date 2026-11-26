import { z } from "zod";
import { managedDeploymentStatusSchema } from "./managed-deployment-status.ts";

const operation = managedDeploymentStatusSchema.unwrap().shape.operation.unwrap().shape;
export const managedRunReportSchema = z.object({
  protocol: z.literal("managed-v3"),
  phase: z.enum(["accepted", ...operation.phase.options]),
  outcome: z.enum([...operation.outcome.unwrap().options, "removed", "superseded"]).nullable(),
  requiredAction: z.enum(["none", "inspect-and-resolve"]),
  activeRelease: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
}).strict().readonly().refine((row) =>
  (row.phase === "complete" || row.phase === "settling") === (row.outcome !== null) &&
  row.requiredAction === (row.phase === "held" ? "inspect-and-resolve" : "none"));
export type ManagedRunReport = z.infer<typeof managedRunReportSchema>;
