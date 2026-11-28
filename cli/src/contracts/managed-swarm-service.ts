import { z } from "zod";
import { err, ok } from "../lib/result.ts";
import type { ManagedServicePlan } from "./managed-service-plan.ts";
import type { VolumeReceipt } from "./owned-volume.ts";
import type { ServiceAction, ServiceScope, ServiceVersion, ServiceWrite, ServiceObservation } from "./swarm-service.ts";

export type ManagedServiceScope = ServiceScope & { readonly dataOwner: string };
export type ManagedServiceAction = ServiceAction & ManagedServiceScope;
/** Ephemeral adapter inputs. Resolved environment values must never enter operation journals or read models. */
export type ManagedServiceInputs = {
  readonly environment: Readonly<Record<string, string>>;
  readonly routing: Readonly<Record<string, string>>;
  readonly volumes: readonly VolumeReceipt[];
};
export type ManagedSwarmServicePort = {
  readonly observe: (scope: ManagedServiceScope) => Promise<ServiceObservation>;
  readonly observeDesired: (action: ManagedServiceAction, plan: ManagedServicePlan, inputs: ManagedServiceInputs) => Promise<ServiceObservation>;
  readonly apply: (action: ManagedServiceAction, expected: ServiceVersion | null, plan: ManagedServicePlan, inputs: ManagedServiceInputs) => Promise<ServiceWrite>;
  /** Restart only an unchanged retained specification from its fully scrubbed, owned name barrier. */
  readonly reactivate: (action: ManagedServiceAction, expected: ServiceVersion, plan: ManagedServicePlan, inputs: ManagedServiceInputs) => Promise<ServiceWrite>;
  readonly fence: (action: ManagedServiceAction, expected: ServiceVersion) => Promise<ServiceWrite>;
  readonly tombstone: (action: ManagedServiceAction, expected: ServiceVersion | null, image: string) => Promise<ServiceWrite>;
};


export const managedServiceScopeSchema = z.object({ app: z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), service: z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), incarnation: z.uuid(), dataOwner: z.uuid() }).strict().readonly().refine((value) => value.incarnation !== value.dataOwner);
const actionSchema = z.object({ app: z.string(), service: z.string(), incarnation: z.uuid(), dataOwner: z.uuid(), action: z.string().max(80), plan: z.string().regex(/^[a-f0-9]{64}$/), deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), effect: z.enum(["apply", "restore", "fence", "remove", "scrub"]) }).strict().readonly();
/** Shared identity validation only; neither a deadline grant nor native ownership evidence. */
export const parseManagedServiceAction = (input: unknown) => {
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success || !managedServiceScopeSchema.safeParse({ app: parsed.data.app, service: parsed.data.service, incarnation: parsed.data.incarnation, dataOwner: parsed.data.dataOwner }).success ||
    !new RegExp(`^${parsed.data.incarnation}:[1-9][0-9]*(?::${parsed.data.effect}:[1-8]|:(?:quiesce|recover|checks)(?::${parsed.data.effect}:[1-8])?)?$`).test(parsed.data.action) || !Number.isSafeInteger(Number(parsed.data.action.split(":")[1])) ||
    /:(?:quiesce|recover|checks)(?::|$)/.test(parsed.data.action) && parsed.data.effect !== "remove" && parsed.data.effect !== "scrub") return err("invalid managed service action");
  return ok<ManagedServiceAction>(parsed.data);
};
