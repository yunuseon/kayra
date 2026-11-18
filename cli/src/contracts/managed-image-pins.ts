import { z } from "zod";
import { parseOwnedImageReference } from "./image-admission.ts";
import { err, ok } from "../lib/result.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const roles = z.enum(["active", "last-known-good", "candidate", "rollback", "unresolved"]);
const schema = z.object({ version: z.literal(3), protocol: z.literal("managed-v3"), runtime: z.literal("swarm"),
  app: z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), incarnation: z.uuid(),
  scope: z.literal("deployment-evidence"), gcSafe: z.literal(false), attachments: z.literal("not-observed"),
  plans: z.array(z.object({ plan: digest, bundle: digest, commit: z.string().regex(/^[a-f0-9]{40}$/),
    roles: z.array(roles).min(1).max(5).readonly(), images: z.array(z.string().max(512)).min(1).max(128).readonly(),
  }).strict().readonly()).max(4096).readonly(),
  retired: z.array(z.object({ service: z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), specification: digest, image: z.string().max(512) }).strict().readonly()).max(32).readonly(),
}).strict().readonly().superRefine((value, context) => {
  if (new Set(value.plans.map((plan) => plan.plan)).size !== value.plans.length || new Set(value.retired.map((item) => item.service)).size !== value.retired.length ||
    value.plans.some((plan) => new Set(plan.roles).size !== plan.roles.length || new Set(plan.images).size !== plan.images.length || plan.images.some((image) => !parseOwnedImageReference(value.app, image).ok)) ||
    value.retired.some((item) => !parseOwnedImageReference(value.app, item.image).ok)) context.addIssue({ code: "custom", message: "inconsistent managed image pins" });
});
export type ManagedImagePins = z.infer<typeof schema>;
/** Conservative coordinator evidence only. Live Docker references and retention policy still prevent authorizing GC from this projection. */
export const parseManagedImagePins = (input: unknown) => {
  const result = schema.safeParse(input); return result.success ? ok<ManagedImagePins>(result.data) : err("invalid managed image pins");
};
export const managedImagePinsSchema = schema;
