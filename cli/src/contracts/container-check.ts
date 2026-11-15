import { createHash } from "node:crypto";
import { z } from "zod";
import { err, ok } from "../lib/result.ts";
import type { ManagedServiceAction } from "./managed-swarm-service.ts";
import type { ServiceVersion } from "./swarm-service.ts";
import { parseManagedServiceAction } from "./managed-swarm-service.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const native = z.string().regex(/^[a-z0-9]{25}$/);
const container = z.string().regex(/^[a-f0-9]{64}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const targetSchema = z.object({ action: z.unknown(), service: native, task: native, container }).strict().readonly();
export const parseCheckTarget = (input: unknown) => {
  const checked = targetSchema.safeParse(input); if (!checked.success) return err("invalid application check target");
  const action = parseManagedServiceAction(checked.data.action);
  if (!action.ok || action.value.effect !== "apply" && action.value.effect !== "restore") return err("invalid application check target action");
  return ok(Object.freeze({ ...checked.data, action: action.value }));
};
export type CheckTarget = Extract<ReturnType<typeof parseCheckTarget>, { readonly ok: true }>["value"];
const commandSchema = z.array(z.string().min(1).max(4096).refine((value) => !value.includes("\0"))).min(1).max(128).readonly();
export const parseCheckCommand = (input: unknown) => { const checked = commandSchema.safeParse(input); return checked.success ? ok(checked.data) : err("unsupported application check command"); };
const schema = z.object({ version: z.literal(1), application: digest, run: z.uuid(), check: z.string().max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  target: z.unknown(), command: commandSchema,
  deadline: positive, timeoutSeconds: positive.max(86400),
}).strict().readonly();
export const parseContainerCheckPlan = (input: unknown) => {
  const checked = schema.safeParse(input); if (!checked.success) return err("invalid application check plan");
  const target = parseCheckTarget(checked.data.target); if (!target.ok) return target;
  return ok(Object.freeze({ ...checked.data, target: target.value }));
};
export type ContainerCheckPlan = Extract<ReturnType<typeof parseContainerCheckPlan>, { readonly ok: true }>["value"];
export const containerCheckDigest = (input: ContainerCheckPlan) => {
  const checked = parseContainerCheckPlan(input); if (!checked.ok) throw new Error(checked.error);
  return createHash("sha256").update(JSON.stringify(checked.value)).digest("hex");
};
export type CheckObservation = { readonly status: "absent" | "foreign" | "unavailable" } |
  { readonly status: "owned"; readonly id: string; readonly running: boolean; readonly exitCode: number | null };
export type CheckWrite = "acknowledged" | "uncertain" | "refused";
export type ContainerCheckPort = {
  /** Create is never execution. An unacknowledged ID is held, not guessed or selected from other execs. */
  readonly create: (plan: ContainerCheckPlan) => Promise<{ readonly status: "created"; readonly id: string } | { readonly status: "uncertain" | "refused" }>;
  /** One dispatch per durable intent; Docker's stopped exec with exit 0 does not prove Start happened. */
  readonly start: (plan: ContainerCheckPlan, id: string, deadline: number) => Promise<CheckWrite>;
  readonly observe: (plan: ContainerCheckPlan, id: string) => Promise<CheckObservation>;
};

export type CheckTargetPort = {
  readonly select: (action: ManagedServiceAction, service: ServiceVersion, task: string) => Promise<{ readonly status: "owned"; readonly target: CheckTarget } | { readonly status: "absent" | "foreign" | "unavailable" }>;
};
