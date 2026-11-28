import { z } from "zod";
import { parseCheckTarget } from "../../contracts/container-check.ts";
import { parseManagedApplicationPlan, managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import type { ServiceVersion } from "../../contracts/swarm-service.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import { parseManagedServiceBarrier } from "./managed-service-barrier.ts";

const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const native = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: time }).strict().readonly();
const checks = z.array(z.object({ target: z.unknown(), native }).strict().readonly()).min(1).max(128).readonly();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export const managedCessationChecks = (input: unknown, application: ManagedApplicationPlan, action: string) => {
  const values = Object.freeze(checks.parse(input).map((item) => {
    const target = parseCheckTarget(item.target); const owner = application.infrastructure.ownership;
    const service = target.ok ? application.services[target.value.action.service] : undefined;
    if (!target.ok || service === undefined || service.role === "retained-dependency" || item.native.id !== target.value.service ||
      target.value.action.app !== owner.app || target.value.action.incarnation !== owner.incarnation || target.value.action.dataOwner !== owner.dataOwner || target.value.action.action.split(":").slice(0, 2).join(":") !== action || managedServiceDigest(service) !== target.value.action.plan) throw new Error("managed check cessation scope disagrees");
    return Object.freeze({ target: target.value, native: item.native });
  }));
  if (new Set(values.map((item) => item.target.container)).size !== values.length || !new RegExp(`^${application.infrastructure.ownership.incarnation}:[1-9][0-9]*$`).test(action)) throw new Error("managed check cessation identity conflicts");
  return Object.freeze(values.toSorted((left, right) => left.target.container.localeCompare(right.target.container)));
};

export const managedCheckCessationSource = (input: unknown) => {
  const raw = z.object({ application: z.unknown(), checks: z.unknown(), run: z.uuid(), action: z.string().max(80), createdAt: time, deadline: time }).strict().readonly().parse(input);
  const application = parseManagedApplicationPlan(raw.application); if (!application.ok || raw.deadline <= raw.createdAt || raw.deadline - raw.createdAt > 90_000) throw new Error("invalid managed check cessation source");
  return Object.freeze({ ...raw, application: application.value, checks: managedCessationChecks(raw.checks, application.value, raw.action) });
};
export type ManagedCheckCessationSource = ReturnType<typeof managedCheckCessationSource>;
const proof = z.object({ container: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(["stopped", "absent"]), native, checkedAt: time }).strict().readonly();
const schema = z.object({ version: z.literal(1), source: digest, plan: digest, run: z.uuid(), action: z.string().max(80), createdAt: time, deadline: time,
  phase: z.enum(["fencing", "complete", "held"]), reason: z.enum(["deadline", "runtime", "authorization"]).nullable(), finishedAt: time.nullable(),
  nodes: z.array(z.object({ name: z.string().min(1).max(48), plan: digest, checks: z.array(z.object({ target: z.unknown(), native }).strict().readonly()).min(1).max(128).readonly(), barrier: z.unknown().nullable(), proofs: z.array(proof).max(128).readonly() }).strict().readonly()).min(1).max(32).readonly(),
}).strict().readonly();
export const parseManagedCheckCessation = (input: unknown) => {
  const raw = schema.parse(input);
  const nodes = Object.freeze(raw.nodes.map((node) => {
    const refs = Object.freeze(node.checks.map((item) => { const target = parseCheckTarget(item.target); if (!target.ok || target.value.action.service !== node.name || target.value.action.plan !== node.plan || target.value.action.action.split(":").slice(0, 2).join(":") !== raw.action || target.value.service !== item.native.id) throw new Error("managed check cessation target disagrees"); return Object.freeze({ ...item, target: target.value }); }));
    const barrier = node.barrier === null ? null : parseManagedServiceBarrier(node.barrier);
    const prior = Object.freeze(refs.map((item) => item.native).filter((item, index, all) => all.findIndex((other) => same(item, other)) === index).toSorted((a, b) => a.version - b.version));
    if (new Set(refs.map((item) => item.target.container)).size !== refs.length || new Set(node.proofs.map((item) => item.container)).size !== node.proofs.length ||
      barrier !== null && (refs.some((item) => item.target.action.app !== barrier.action.app || item.target.action.incarnation !== barrier.action.incarnation || item.target.action.dataOwner !== barrier.action.dataOwner) || barrier.action.service !== node.name || barrier.action.plan !== node.plan || barrier.action.action !== raw.action + ":checks" || barrier.action.deadline !== raw.deadline || barrier.createdAt < raw.createdAt || !same(barrier.prior, prior)) ||
      node.proofs.some((item) => barrier?.phase !== "complete" || barrier.proof === null || !refs.some((ref) => ref.target.container === item.container && ref.target.service === item.native.id) || item.native.version < barrier.proof.native.version || item.checkedAt < barrier.proof.at || item.checkedAt >= raw.deadline)) throw new Error("managed check cessation proof disagrees");
    return Object.freeze({ ...node, checks: refs, barrier });
  }));
  if (raw.deadline <= raw.createdAt || raw.deadline - raw.createdAt > 90_000 || new Set(nodes.map((node) => node.name)).size !== nodes.length || (raw.phase === "held") !== (raw.reason !== null) || (raw.phase === "complete") !== (raw.finishedAt !== null) ||
    raw.finishedAt !== null && (raw.finishedAt < raw.createdAt || raw.finishedAt >= raw.deadline || nodes.some((node) => node.proofs.length !== node.checks.length || node.proofs.some((item) => item.checkedAt > (raw.finishedAt ?? 0))))) throw new Error("inconsistent managed check cessation");
  return Object.freeze({ ...raw, nodes });
};
export type ManagedCheckCessation = ReturnType<typeof parseManagedCheckCessation>;
export const managedCheckCessationNodes = (source: ManagedCheckCessationSource) => Object.freeze([...new Set(source.checks.map((item) => item.target.action.service))].toSorted().map((name) => {
  const service = source.application.services[name]; if (service === undefined) throw new Error("managed check cessation service missing");
  return Object.freeze({ name, plan: managedServiceDigest(service), checks: Object.freeze(source.checks.filter((item) => item.target.action.service === name)) });
}));
export const managedCheckCessationPlan = (source: ManagedCheckCessationSource) => managedApplicationDigest(source.application);
export const managedCheckCessationPrior = (prior: readonly ServiceVersion[], state: ManagedCheckCessation | null | undefined, name: string) => {
  const node = state?.nodes.find((item) => item.name === name); const barrier = node?.barrier;
  const values = [...prior, ...(barrier?.steps.flatMap((item) => item.expected === null ? Object.freeze([]) : Object.freeze([item.expected])) ?? []), ...(barrier?.proof === undefined || barrier.proof === null ? [] : [barrier.proof.native]), ...(node?.proofs.map((item) => item.native) ?? [])];
  return Object.freeze(values.filter((item, index) => values.findIndex((other) => same(item, other)) === index).toSorted((a, b) => a.version - b.version));
};
