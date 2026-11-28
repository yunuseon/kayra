import { z } from "zod";
import { names } from "../lib/names.ts";
import { migrationReasonSchema } from "./migration-resolution.ts";

export const managedRecreationRequestFields = z.object({
  request: z.uuid(),
  removal: z.uuid(),
  generation: z.uuid(),
  reason: migrationReasonSchema,
}).strict();

export const managedRecreationRegistrationRequest = managedRecreationRequestFields.extend({
  app: z.string().regex(names.app.pattern),
}).readonly().refine((value) => value.request !== value.removal);
