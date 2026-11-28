import { z } from "zod";
import { names } from "../lib/names.ts";
import { err, ok } from "../lib/result.ts";

const states = ["available", "starting", "unhealthy", "missing", "mismatch", "unavailable"] as const;
const count = z.number().int().nonnegative().max(100000).nullable();
const service = z.object({ name: z.string().regex(names.app.pattern), state: z.enum(states), currentTasks: count, healthyTasks: count, ignoredHistoricalTasks: count }).strict().readonly();
const schema = z.object({ version: z.literal(1), app: z.string().regex(names.app.pattern), incarnation: z.uuid(), runtime: z.enum(["compose", "swarm"]),
  scope: z.literal("runtime-services"), observedAt: z.number().int().positive(), state: z.enum([...states, "not-requested", "unsupported"]), services: z.array(service).max(128).readonly(),
}).strict().readonly().superRefine((value, context) => {
  if ((value.runtime === "compose") !== (value.state === "unsupported") ||
    (value.state === "not-requested" || value.state === "unsupported") !== (value.services.length === 0) ||
    value.services.length > 0 && value.state !== (value.services.find((item) => item.state !== "available")?.state ?? "available") ||
    value.services.some((item) => (item.state === "available") !== (item.healthyTasks !== null && item.healthyTasks > 0) || (item.healthyTasks === null) !== (item.currentTasks === null) || item.healthyTasks !== null && item.currentTasks !== null && item.healthyTasks > item.currentTasks) ||
    new Set(value.services.map((item) => item.name)).size !== value.services.length) context.addIssue({ code: "custom", message: "inconsistent runtime health" });
});
export type DeploymentHealth = z.infer<typeof schema>;
export type DeploymentHealthPort = { readonly snapshot: () => Promise<readonly DeploymentHealth[]> };

/** Current service observations are separate from historical release certification and routed readiness. */
export const parseDeploymentHealth = (input: unknown) => {
  const parsed = schema.safeParse(input);
  return parsed.success ? ok<DeploymentHealth>(parsed.data) : err("invalid deployment runtime health");
};

export const deploymentHealthSchema = schema;
