import { z } from "zod";
import { parseCheckTarget } from "../../contracts/container-check.ts";
import { parseManagedServiceBarrier } from "./managed-service-barrier.ts";

const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const native = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: time }).strict().readonly();
const proof = z.object({ container: digest, kind: z.enum(["stopped", "absent"]), native, checkedAt: time }).strict().readonly();
const schema = z.object({ version: z.literal(1), source: digest, run: z.uuid(), action: z.string().max(80), app: name, incarnation: z.uuid(), dataOwner: z.uuid(), createdAt: time, deadline: time,
  phase: z.enum(["fencing", "complete", "held"]), reason: z.enum(["deadline", "runtime", "authorization"]).nullable(), finishedAt: time.nullable(), cursor: z.number().int().min(0).max(63),
  nodes: z.array(z.object({ name, plan: digest, prior: z.array(native).max(64).readonly(), waitFor: z.array(name).max(32).readonly(), checks: z.array(z.object({ target: z.unknown(), native }).strict().readonly()).max(128).readonly(), barrier: z.unknown().nullable(), proofs: z.array(proof).max(128).readonly() }).strict().readonly()).max(64).readonly(),
}).strict().readonly();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const parseManagedForwardEffects = (input: unknown) => {
  const raw = schema.parse(input);
  const nodes = Object.freeze(raw.nodes.map((node) => {
    const checks = Object.freeze(node.checks.map((check) => { const target = parseCheckTarget(check.target);
      if (!target.ok || target.value.action.app !== raw.app || target.value.action.incarnation !== raw.incarnation || target.value.action.dataOwner !== raw.dataOwner || target.value.action.service !== node.name || target.value.service !== check.native.id || Number(target.value.action.action.split(":")[1]) >= Number(raw.action.split(":")[1])) throw new Error("forward effect check scope disagrees");
      return Object.freeze({ ...check, target: target.value });
    }));
    const barrier = node.barrier === null ? null : parseManagedServiceBarrier(node.barrier);
    if (barrier !== null && (barrier.action.app !== raw.app || barrier.action.incarnation !== raw.incarnation || barrier.action.dataOwner !== raw.dataOwner || barrier.action.service !== node.name || barrier.action.plan !== node.plan || barrier.action.action !== raw.action + ":quiesce" || barrier.action.deadline !== raw.deadline || barrier.createdAt < raw.createdAt || !same(barrier.prior, node.prior)) ||
      new Set(node.waitFor).size !== node.waitFor.length || node.waitFor.some((name) => name === node.name || !raw.nodes.some((other) => other.name === name)) ||
      new Set(checks.map((check) => check.target.container)).size !== checks.length || new Set(node.proofs.map((item) => item.container)).size !== node.proofs.length ||
      node.proofs.some((item) => barrier?.phase !== "complete" || barrier.proof === null || !checks.some((check) => check.target.container === item.container && check.target.service === item.native.id) || item.native.version < barrier.proof.native.version || item.checkedAt < barrier.proof.at || item.checkedAt >= raw.deadline)) throw new Error("forward effect node proof disagrees");
    return Object.freeze({ ...node, checks, barrier });
  }));
  const ordered = (remaining: readonly string[]): boolean => { if (remaining.length === 0) return true; const next = remaining.filter((name) => nodes.find((node) => node.name === name)?.waitFor.some((other) => remaining.includes(other))); return next.length < remaining.length && ordered(next); };
  if (!new RegExp(`^${raw.incarnation}:[1-9][0-9]*$`).test(raw.action) || !Number.isSafeInteger(Number(raw.action.split(":")[1])) || raw.incarnation === raw.dataOwner || raw.deadline !== raw.createdAt + 90_000 || new Set(nodes.map((node) => node.name)).size !== nodes.length || raw.cursor >= Math.max(1, nodes.length) || !ordered(nodes.map((node) => node.name)) ||
    (raw.phase === "held") !== (raw.reason !== null) || (raw.phase === "complete") !== (raw.finishedAt !== null) || raw.finishedAt !== null && (raw.finishedAt < raw.createdAt || raw.finishedAt >= raw.deadline || nodes.some((node) => node.barrier?.phase !== "complete" || node.barrier.proof === null || node.barrier.proof.at > (raw.finishedAt ?? 0) || node.proofs.length !== node.checks.length || node.proofs.some((proof) => proof.checkedAt > (raw.finishedAt ?? 0))))) throw new Error("inconsistent forward effect state");
  return Object.freeze({ ...raw, nodes });
};
export type ManagedForwardEffects = ReturnType<typeof parseManagedForwardEffects>;
