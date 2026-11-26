import { z } from "zod";
import type { RunAnswer, RunsAnswer } from "./reporting.ts";
import { managedRunReportSchema } from "./managed-run-report.ts";

export const deployedRunSchema = z.object({ sha: z.string(), time: z.iso.datetime() });
export const runSchema = z.object({
  id: z.string(),
  state: z.enum(["queued", "running", "success", "failure", "superseded"]),
  why: z.string(),
  what: z.string(),
  sha: z.string().exactOptional(),
  started: z.iso.datetime(),
  finished: z.iso.datetime().exactOptional(),
  error: z.string().exactOptional(),
  urls: z.array(z.string()).exactOptional(),
  checks: z.array(z.object({ url: z.string(), status: z.number().int(), ok: z.boolean() })).exactOptional(),
  managed: managedRunReportSchema.exactOptional(),
}) satisfies z.ZodType<RunAnswer>;
export const runsSchema = z.object({
  app: z.string(),
  protocol: z.literal("managed-v3").exactOptional(),
  live: deployedRunSchema.exactOptional(),
  runs: z.array(runSchema),
}).refine((answer) => answer.runs.every((row) => (row.managed === undefined) === (answer.protocol === undefined))) satisfies z.ZodType<RunsAnswer>;
