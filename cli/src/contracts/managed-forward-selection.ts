import { z } from "zod";
import { migrationReasonSchema } from "./migration-resolution.ts";
import { err, ok } from "../lib/result.ts";

export const managedForwardSelectionRequestSchema = z.object({ app: z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), blockedRun: z.uuid(), request: z.uuid(), commit: z.string().regex(/^[a-f0-9]{40}$/), reason: migrationReasonSchema }).strict().readonly().refine((value) => value.blockedRun !== value.request);
export type ManagedForwardSelectionRequest = z.infer<typeof managedForwardSelectionRequestSchema>;
/** A target selection asks for an isolated build, never for a migration or workload start. Actor identity belongs to the trusted transport. */
export const parseManagedForwardSelectionRequest = (input: unknown) => {
  const result = managedForwardSelectionRequestSchema.safeParse(input);
  return result.success ? ok<ManagedForwardSelectionRequest>(result.data) : err("invalid managed forward selection request");
};
