import { z } from "zod";
import { parseCheckTarget } from "./container-check.ts";
import { parseManagedServiceAction } from "./managed-swarm-service.ts";
import { err, ok } from "../lib/result.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({ target: z.unknown(), barrier: z.unknown(), native: z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: positive }).strict().readonly() }).strict().readonly();
export const parseCheckContainerFence = (input: unknown) => {
  const checked = schema.safeParse(input); if (!checked.success) return err("invalid check container fence");
  const target = parseCheckTarget(checked.data.target); const barrier = parseManagedServiceAction(checked.data.barrier);
  if (!target.ok || !barrier.ok || barrier.value.effect !== "scrub" || checked.data.native.id !== target.value.service ||
    barrier.value.app !== target.value.action.app || barrier.value.incarnation !== target.value.action.incarnation || barrier.value.dataOwner !== target.value.action.dataOwner || barrier.value.service !== target.value.action.service ||
    Number(barrier.value.action.split(":")[1]) < Number(target.value.action.action.split(":")[1])) return err("check container fence scope disagrees");
  return ok(Object.freeze({ ...checked.data, target: target.value, barrier: barrier.value }));
};
export type CheckContainerFence = Extract<ReturnType<typeof parseCheckContainerFence>, { readonly ok: true }>["value"];
export type CheckContainerFencePort = {
  /** Caller supplies a previously selected durable target and holds the lifecycle writer fence. Read-only cessation proof never establishes whether a check ran or what effects it had. */
  readonly observe: (request: CheckContainerFence) => Promise<{ readonly status: "pending" | "foreign" | "unavailable" } |
    { readonly status: "fenced"; readonly kind: "stopped" | "absent"; readonly native: CheckContainerFence["native"]; readonly checkedAt: number }>;
};
