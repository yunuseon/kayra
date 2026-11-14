import { z } from "zod";
import { names } from "../lib/names.ts";
import { err, ok } from "../lib/result.ts";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const role = z.enum(["active", "last-known-good", "candidate", "rollback", "unresolved"]);
const pin = z.object({ plan: digest, workload: digest, commit: z.string().regex(/^[0-9a-f]{40}$/),
  roles: z.array(role).min(1).max(5).readonly(), images: z.array(z.string()).min(1).max(128).readonly(),
}).strict().readonly();
const schema = z.object({ version: z.literal(1), app: z.string().regex(names.app.pattern), incarnation: z.uuid(), runtime: z.enum(["compose", "swarm"]),
  scope: z.literal("coordinator-plans"), gcSafe: z.literal(false), plans: z.array(pin).max(4096).readonly(),
}).strict().readonly().superRefine((value, context) => {
  const image = new RegExp(`^localhost:5000/${value.app}/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[0-9a-f]{64}$`);
  if (value.runtime === "compose" && value.plans.length !== 0 || new Set(value.plans.map((item) => item.plan)).size !== value.plans.length ||
    value.plans.some((item) => new Set(item.roles).size !== item.roles.length || new Set(item.images).size !== item.images.length || item.images.some((name) => !image.test(name)))) context.addIssue({ code: "custom", message: "inconsistent deployment image pins" });
});
export type DeploymentImagePins = z.infer<typeof schema>;

/** A plan snapshot is not live attachment inventory or authorization to run registry GC. */
export const parseDeploymentImagePins = (input: unknown) => {
  const parsed = schema.safeParse(input);
  return parsed.success ? ok<DeploymentImagePins>(parsed.data) : err("invalid deployment image pins");
};

export const deploymentImagePinsSchema = schema;
