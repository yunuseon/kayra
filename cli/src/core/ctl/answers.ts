import { z } from "zod";
import type { ReleasesAnswer } from "../../contracts/reporting.ts";
import { deployedRunSchema } from "../../contracts/run-reporting.ts";
export { runSchema, runsSchema } from "../../contracts/run-reporting.ts";

/** `ctl rollback <app> --json`, as this kayra reads it. */
export const releasesSchema = z.object({
  app: z.string(),
  releases: z.array(deployedRunSchema.extend({ live: z.boolean() })),
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
