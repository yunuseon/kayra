/* Validated journal snapshots are immutable after parsing. */
/* eslint-disable functional/prefer-immutable-types */
import { z } from "zod";
import { parseSwarmAuthority } from "../../contracts/swarm-authority.ts";
import type { SwarmAuthority } from "../../contracts/swarm-authority.ts";
import type { SwarmHostObservation } from "../../contracts/resource-authority.ts";
import { err, ok } from "../../lib/result.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const budget = z.object({ cpu: positive, memory: positive }).strict();
const release = z.object({ plan: z.string().regex(/^[0-9a-f]{64}$/), budget }).strict();
const charge = z.object({
  app: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), incarnation: z.uuid(), sequence: positive,
  previous: release.nullable(), target: release, peak: budget, deadline: positive,
  result: z.enum(["pending", "target", "previous", "absent"]),
}).strict();
const schema = z.object({ version: z.literal(1), host: z.unknown(), charges: z.array(charge).max(1024) }).strict();
type Budget = { readonly cpu: number; readonly memory: number };
type Release = { readonly plan: string; readonly budget: Budget };
export type ResourceCharge = {
  readonly app: string; readonly incarnation: string; readonly sequence: number;
  readonly previous: Release | null; readonly target: Release; readonly peak: Budget;
  readonly deadline: number; readonly result: "pending" | "target" | "previous" | "absent";
};
const active = (item: ResourceCharge) => item.result === "target" ? item.target : item.result === "previous" ? item.previous : null;
const charged = (item: ResourceCharge) => item.result === "pending" ? item.peak : active(item)?.budget;
const sameBudget = (a: z.infer<typeof budget>, b: z.infer<typeof budget>) => a.cpu === b.cpu && a.memory === b.memory;
const sameRelease = (a: z.infer<typeof release> | null, b: z.infer<typeof release> | null) => a === null || b === null ? a === b : a.plan === b.plan && sameBudget(a.budget, b.budget);
const totalFits = (host: SwarmAuthority, charges: readonly ResourceCharge[]) => {
  const total = charges.reduce((sum, item) => ({ cpu: sum.cpu + (charged(item)?.cpu ?? 0), memory: sum.memory + (charged(item)?.memory ?? 0) }),
    { cpu: host.profile.platform_cpu_millicores, memory: host.profile.platform_memory_bytes });
  return Number.isSafeInteger(total.cpu) && Number.isSafeInteger(total.memory) && total.cpu <= host.profile.cpu_millicores && total.memory <= host.profile.memory_bytes;
};

/** Per-app peak envelopes replace active charges, rather than adding a second full peak. */
export const parseResourceBook = (input: unknown) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return err("invalid resource accounting");
  const host = parseSwarmAuthority(parsed.data.host);
  if (!host.ok) return err("invalid resource host authority");
  const charges = parsed.data.charges;
  if (new Set(charges.map((item) => item.app)).size !== charges.length || new Set(charges.map((item) => item.incarnation)).size !== charges.length ||
    charges.some((item) => item.peak.cpu < Math.max(item.previous?.budget.cpu ?? 0, item.target.budget.cpu) || item.peak.memory < Math.max(item.previous?.budget.memory ?? 0, item.target.budget.memory)) ||
    !totalFits(host.value, charges)) return err("inconsistent resource accounting");
  charges.forEach((item) => { Object.freeze(item.peak); Object.freeze(item.target.budget); Object.freeze(item.target);
    if (item.previous !== null) { Object.freeze(item.previous.budget); Object.freeze(item.previous); } Object.freeze(item); });
  return ok<ResourceBook>(Object.freeze({ version: 1, host: host.value, charges: Object.freeze(charges) }));
};
export type ResourceBook = { readonly version: 1; readonly host: SwarmAuthority; readonly charges: readonly ResourceCharge[] };

/** Admission requires a current normalized runtime observation of this exact host. */
export const reserveResources = (input: unknown, authority: SwarmAuthority, observation: SwarmHostObservation, requested: unknown, now: number) => {
  const host = parseSwarmAuthority(authority);
  const checked = charge.safeParse(requested);
  if (!host.ok || !checked.success || checked.data.result !== "pending" || !Number.isSafeInteger(now) || now < 0) return err("invalid resource intent");
  const current = parseResourceBook(input ?? { version: 1, host: host.value, charges: [] });
  if (!current.ok) return current;
  if (JSON.stringify(current.value.host) !== JSON.stringify(host.value)) return err("resource host authority changed; intervention required");
  const intent = checked.data;
  const previous = current.value.charges.find((item) => item.app === intent.app);
  if (previous?.incarnation === intent.incarnation && previous.sequence === intent.sequence) {
    if (!sameRelease(previous.previous, intent.previous) || !sameRelease(previous.target, intent.target) || !sameBudget(previous.peak, intent.peak) || previous.deadline !== intent.deadline) return err("resource action has conflicting intent");
    // A replay exposes recorded state only; it neither extends a lease nor authorizes an effect.
    return current;
  }
  if (previous !== undefined && (previous.result === "pending" || (previous.incarnation === intent.incarnation ? previous.sequence >= intent.sequence : active(previous) !== null))) return err("app resource action is pending or stale");
  if (!sameRelease(previous === undefined ? null : active(previous), intent.previous)) return err("previous active resource charge changed");
  if (intent.deadline <= now || intent.deadline - now > 90_000) return err("resource deadline expired or exceeds scheduling ceiling");
  if (observation.status !== "ready" || observation.node !== host.value.node || observation.cluster !== host.value.cluster || observation.network !== host.value.network.id ||
    observation.capacity.cpu !== host.value.profile.cpu_millicores || observation.capacity.memory !== host.value.profile.memory_bytes ||
    observation.standing.cpu !== host.value.profile.platform_cpu_millicores || observation.standing.memory !== host.value.profile.platform_memory_bytes) return err("current resource host observation required");
  const next = parseResourceBook({ version: 1, host: host.value, charges: [...current.value.charges.filter((item) => item.app !== intent.app), intent] });
  return next.ok ? next : err("insufficient declared host capacity or invalid peak charge");
};

/** Trusted reconciliation only: expiry by itself is never evidence for releasing resources. */
export const settleResources = (input: unknown, app: string, incarnation: string, sequence: number, result: "target" | "previous" | "absent") => {
  const current = parseResourceBook(input);
  if (!current.ok) return current;
  const item = current.value.charges.find((item) => item.app === app);
  if (item?.incarnation !== incarnation || item.sequence !== sequence) return err("resource settlement does not own this action");
  if (item.result !== "pending") return item.result === result ? current : err("resource action already settled differently");
  return parseResourceBook({ ...current.value, charges: current.value.charges.map((charge) => charge === item ? { ...charge, result } : charge) });
};
