import { z } from "zod";
import type { ReleasesAnswer, RunAnswer, RunsAnswer } from "../../contracts/reporting.ts";

const deployed = z.object({ sha: z.string(), time: z.iso.datetime() });

/** One run, as `ctl runs --json` lists it and `ctl deploy --json` ends with it. */
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
}) satisfies z.ZodType<RunAnswer>;

/** `ctl runs <app> --json`, as this kayra reads it. */
export const runsSchema = z.object({
  app: z.string(),
  live: deployed.exactOptional(),
  runs: z.array(runSchema),
}) satisfies z.ZodType<RunsAnswer>;

/** `ctl rollback <app> --json`, as this kayra reads it. */
export const releasesSchema = z.object({
  app: z.string(),
  releases: z.array(deployed.extend({ live: z.boolean() })),
}) satisfies z.ZodType<ReleasesAnswer>;

/** The answer as the schema has it, or nothing: then it is not the answer this kayra expects. */
export const parsed = <T>(schema: z.ZodType<T>, answer: string) => {
  try {
    const json: unknown = JSON.parse(answer);
    const result = schema.safeParse(json);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
};
