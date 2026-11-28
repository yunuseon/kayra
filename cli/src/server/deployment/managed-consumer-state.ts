import { z } from "zod";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import { parseManagedServiceExecution } from "./managed-service-execution.ts";
import { parseManagedServiceBarrier } from "./managed-service-barrier.ts";
import { routedHttp } from "./http-convergence.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().max(48).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const native = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: positive }).strict().readonly();
const reference = z.object({ action: z.unknown(), native }).strict().readonly();
const routed = z.object({ app: name, service: name, incarnation: z.uuid(), action: z.string().max(80), plan: digest, checkedAt: positive, status: z.enum(["ready", "unready", "unavailable"]) }).strict().readonly();
const readiness = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("running"), action: z.unknown(), native, at: positive, routed: routed.nullable() }).strict().readonly(),
  z.object({ kind: z.literal("removed"), native, at: positive }).strict().readonly(),
]);
const legacySchema = z.object({ version: z.literal(1), app: name, incarnation: z.uuid(), dataOwner: z.uuid(), run: z.uuid(), action: z.string().max(80),
  plan: digest, previous: digest.nullable(), preparation: digest, createdAt: positive, deadline: positive,
  retained: z.array(z.object({ name, action: z.unknown(), native }).strict().readonly()).max(32).readonly(),
  nodes: z.array(z.object({ name, target: digest.nullable(), baseline: reference.nullable(), execution: z.unknown().nullable(), quiescence: z.unknown().nullable(), ready: readiness.nullable() }).strict().readonly()).max(32).readonly(),
  cursor: z.number().int().min(0).max(31), phase: z.enum(["updating", "ready", "held"]), reason: z.enum(["deadline", "service", "dependency", "authorization"]).nullable(), verifiedAt: positive.nullable(),
}).strict().readonly();
const schema = z.union([legacySchema, legacySchema.unwrap().extend({ version: z.literal(2), maintenance: digest }).strict().readonly()]);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Private forward reconciliation proof, not a promoted release or an admission grant. */
export const parseManagedConsumerState = (input: unknown) => {
  const checked = schema.safeParse(input); if (!checked.success) throw new Error("invalid managed consumer state"); const state = checked.data; const verifiedAt = state.verifiedAt;
  const action = (input: unknown, service: string) => {
    const parsed = parseManagedServiceAction(input);
    if (!parsed.ok || parsed.value.app !== state.app || parsed.value.incarnation !== state.incarnation || parsed.value.dataOwner !== state.dataOwner || parsed.value.service !== service) throw new Error("managed consumer action scope disagrees");
    return parsed.value;
  };
  const retained = Object.freeze(state.retained.map((value) => Object.freeze({ ...value, action: action(value.action, value.name) })));
  const nodes = Object.freeze(state.nodes.map((value) => {
    const baseline = value.baseline === null ? null : Object.freeze({ ...value.baseline, action: action(value.baseline.action, value.name) });
    const execution = value.execution === null ? null : parseManagedServiceExecution(value.execution);
    const quiescence = value.quiescence === null ? null : parseManagedServiceBarrier(value.quiescence);
    const ready = value.ready?.kind === "running" ? Object.freeze({ ...value.ready, action: action(value.ready.action, value.name) }) : value.ready;
    if (state.version === 2 && quiescence !== null || value.target === null && baseline === null || baseline !== null && (state.previous === null || Number(baseline.action.action.split(":")[1]) >= Number(state.action.split(":")[1]) || baseline.action.effect !== "apply" && baseline.action.effect !== "restore") ||
      execution !== null && (value.target === null || execution.mode !== "apply" || execution.action.action !== state.action || execution.action.effect !== "apply" || execution.action.plan !== value.target || execution.action.deadline !== state.deadline || execution.createdAt < state.createdAt || !same(action(execution.action, value.name), execution.action)) ||
      quiescence !== null && (quiescence.action.plan !== baseline?.action.plan || quiescence.action.action !== state.action || quiescence.action.deadline !== state.deadline || quiescence.createdAt < state.createdAt || !same(action(quiescence.action, value.name), quiescence.action)) ||
      ready !== null && (ready.at < state.createdAt || ready.at >= state.deadline || (ready.kind === "removed" ? value.target !== null || (state.version === 1 ? quiescence?.phase !== "complete" || !same(ready.native, quiescence.proof?.native) : baseline === null) :
        execution?.phase !== "converged" || execution.verified === null || !same(ready.action, execution.action) || ready.native.id !== execution.verified.native.id || ready.native.version < execution.verified.native.version ||
        ready.routed !== null && !routedHttp(ready.action, ready.routed, ready.at)))) throw new Error("managed consumer child evidence disagrees");
    return Object.freeze({ ...value, baseline, execution, quiescence, ready });
  }));
  if (state.incarnation === state.dataOwner || !new RegExp(`^${state.incarnation}:[1-9][0-9]*$`).test(state.action) || !Number.isSafeInteger(Number(state.action.split(":")[1])) || state.deadline !== state.createdAt + 90_000 ||
    new Set(nodes.map((node) => node.name)).size !== nodes.length || new Set(retained.map((value) => value.name)).size !== retained.length || retained.some((value) => nodes.some((node) => node.name === value.name)) ||
    (state.phase === "held") !== (state.reason !== null) || (state.phase === "ready") !== (state.verifiedAt !== null) ||
    state.phase === "ready" && nodes.some((node) => node.ready === null) ||
    verifiedAt !== null && (verifiedAt < state.createdAt || verifiedAt >= state.deadline || nodes.some((node) => node.ready !== null && node.ready.at > verifiedAt || node.ready?.kind === "running" && node.ready.routed !== null && !routedHttp(node.ready.action, node.ready.routed, verifiedAt)))) throw new Error("inconsistent managed consumer state");
  return Object.freeze({ ...state, retained, nodes });
};
export type ManagedConsumerState = ReturnType<typeof parseManagedConsumerState>;
