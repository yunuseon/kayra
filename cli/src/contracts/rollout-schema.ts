import { z } from "zod";
import { parseRollout } from "./rollout.ts";

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
const args = z.array(z.string().min(1)).min(1).max(4096);
const timeout = z.number().int().positive().max(Math.floor(Number.MAX_SAFE_INTEGER / 1000));
const command = z.strictObject({ id: name, service: name, command: args, timeout_seconds: timeout });
const recovery = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("replay-safe") }),
  z.strictObject({ kind: z.literal("status-probe"), command: args, timeout_seconds: timeout }),
]);

/** JSON-schema surface for the same rollout contract used by the dependency-light builder. */
export const rolloutManifestSchema = z.strictObject({
  strategy: z.enum(["rolling", "maintenance"]),
  mixed_version_compatible: z.boolean(),
  rollback_compatible: z.boolean(),
  services: z.record(name, z.strictObject({
    role: z.enum(["http", "worker", "singleton", "retained-dependency"]),
    overlap: z.enum(["allowed", "forbidden", "coordinated"]),
    handoff_check: name.optional(),
  })),
  migrations: z.array(command.extend({ recovery })).max(4096).optional(),
  checks: z.array(command).max(4096).optional(),
}).superRefine((value, context) => {
  const parsed = parseRollout(value);
  if (!parsed.ok) context.addIssue({ code: "custom", message: parsed.error });
});
