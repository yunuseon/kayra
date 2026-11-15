import { z } from "zod";
import { err, ok } from "../lib/result.ts";

const id = z.string().regex(/^[a-z0-9]{25}$/);
const scope = z.object({ version: z.literal(1), app: z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), incarnation: z.uuid(),
  node: id, cluster: id, name: z.string(),
}).strict().readonly().refine((value) => value.name === `kayra-app-${value.incarnation}`);
const grant = z.object({ scope, id }).strict().readonly();
export const appOverlayActionSchema = z.object({ scope, operation: z.uuid(), deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().readonly();
export type AppOverlayScope = z.infer<typeof scope>;
export type AppOverlayGrant = z.infer<typeof grant>;
export type AppOverlayAction = z.infer<typeof appOverlayActionSchema>;
export type AppOverlayObservation = { readonly status: "absent" | "foreign" | "ambiguous" | "unavailable" } | { readonly status: "owned"; readonly grant: AppOverlayGrant };
export type AppOverlayPort = {
  readonly observe: (scope: AppOverlayScope) => Promise<AppOverlayObservation>;
  readonly create: (action: AppOverlayAction) => Promise<"acknowledged" | "uncertain" | "conflict" | "refused">;
};
export const parseAppOverlayScope = (input: unknown) => { const checked = scope.safeParse(input); return checked.success ? ok<AppOverlayScope>(checked.data) : err("invalid app overlay scope"); };
export const parseAppOverlayGrant = (input: unknown) => { const checked = grant.safeParse(input); return checked.success ? ok<AppOverlayGrant>(checked.data) : err("invalid app overlay grant"); };
