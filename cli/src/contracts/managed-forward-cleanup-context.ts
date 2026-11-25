import type { ManagedServiceAction } from "./managed-swarm-service.ts";
import type { ManagedWorkloadPort } from "./managed-workloads.ts";
import type { JobPort } from "./one-shot-job.ts";
import type { CheckContainerFencePort } from "./check-container-fence.ts";
import { z } from "zod";
import { parseManagedExecutionContext } from "./managed-execution-context.ts";
import { parseCheckTarget } from "./container-check.ts";
import { managedServiceDigest } from "./managed-service-plan.ts";
import { err, ok } from "../lib/result.ts";

const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const native = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: time }).strict().readonly();
const schema = z.object({ version: z.literal(1), protocol: z.literal("managed-v3"), runtime: z.literal("swarm"), kind: z.literal("forward-cleanup"),
  blocked: z.unknown(), run: z.uuid(), action: z.string().max(80), source: digest, reservation: digest, createdAt: time, deadline: time,
  checks: z.array(z.object({ target: z.unknown(), native }).strict().readonly()).max(128).readonly(),
}).strict().readonly();

/** Operational format only. The deployment owner authenticates its accepted continuation, blocked checkpoint and pending lease. */
export const parseManagedForwardCleanupContext = (input: unknown) => {
  const raw = schema.safeParse(input); if (!raw.success) return err("invalid managed forward cleanup context"); const value = raw.data;
  const blocked = parseManagedExecutionContext(value.blocked); if (!blocked.ok) return err("invalid blocked cleanup context"); const base = blocked.value;
  if (base.application.rollout.strategy !== "maintenance" || value.run === base.run || value.createdAt < base.createdAt || value.deadline !== value.createdAt + 90_000 ||
    !new RegExp(`^${base.owner.incarnation}:[1-9][0-9]*$`).test(value.action) || !Number.isSafeInteger(Number(value.action.split(":")[1])) || Number(value.action.split(":")[1]) <= Number(base.action.split(":")[1])) return err("managed forward cleanup operation disagrees");
  const checks = value.checks.map((check) => {
    const target = parseCheckTarget(check.target); if (!target.ok) return undefined; const service = base.application.services[target.value.action.service]; const action = target.value.action;
    if (service === undefined || service.role === "retained-dependency" || action.app !== base.owner.app || action.incarnation !== base.owner.incarnation || action.dataOwner !== base.owner.dataOwner || action.action.split(":").slice(0, 2).join(":") !== base.action || action.plan !== managedServiceDigest(service) || target.value.service !== check.native.id) return undefined;
    return Object.freeze({ target: target.value, native: check.native });
  });
  if (checks.some((check) => check === undefined) || new Set(checks.map((check) => check?.target.container)).size !== checks.length) return err("managed forward cleanup checks disagree");
  return ok(Object.freeze({ ...value, blocked: base, checks: Object.freeze(checks.filter((check) => check !== undefined)) }));
};
export type ManagedForwardCleanupContext = Extract<ReturnType<typeof parseManagedForwardCleanupContext>, { readonly ok: true }>["value"];
export const managedForwardCleanupServices = (context: ManagedForwardCleanupContext) => Object.freeze([...new Set([...Object.keys(context.blocked.application.services), ...Object.keys(context.blocked.previous?.services ?? {})])].toSorted().flatMap((name) => {
  const service = context.blocked.application.services[name] ?? context.blocked.previous?.services[name];
  return service === undefined || service.role === "retained-dependency" ? Object.freeze([]) : Object.freeze([service]);
}));

/** Narrow runtime capabilities. No secrets, job execution, volume mutation, workload starts or admission methods. */
export type ManagedForwardCleanupRuntimePort = {
  readonly context: ManagedForwardCleanupContext;
  readonly allowed: (action: ManagedServiceAction | null) => Promise<boolean>;
  readonly services: Readonly<Pick<ManagedWorkloadPort, "observe" | "tombstone">>;
  readonly jobs: Readonly<Pick<JobPort, "observe">>;
  readonly containers: CheckContainerFencePort;
};
