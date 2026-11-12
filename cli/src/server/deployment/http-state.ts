import { z } from "zod";
import { err, ok } from "../../lib/result.ts";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const action = z.string().max(80);
const nativeVersion = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: positive }).strict().readonly();
const verified = z.object({ plan: digest, commit: z.string().regex(/^[0-9a-f]{40}$/), action,
  service: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), native: nativeVersion, verifiedAt: positive,
}).strict().readonly();
const step = z.object({ effect: z.enum(["apply", "restore", "fence", "remove", "scrub"]), plan: digest,
  expected: nativeVersion.nullable(), deadline: positive,
}).strict().readonly();
const operation = z.object({
  request: z.uuid(), ticket: action, action, plan: digest, commit: z.string().regex(/^[0-9a-f]{40}$/),
  service: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), deadline: positive,
  previous: verified.nullable(), recoveryDeadline: positive.nullable(),
  phase: z.enum(["prepared", "admitted", "applying", "verifying", "recovering", "held", "succeeded", "failed", "cancelled"]),
  reason: z.enum(["deadline", "admission", "runtime", "routed", "cancelled"]).nullable(),
  steps: z.array(step).max(5).readonly(), verified: verified.nullable(),
}).strict().readonly();
const schema = z.object({
  version: z.literal(1), app: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), incarnation: z.uuid(),
  requested: digest.nullable(), desired: digest.nullable(), active: verified.nullable(), lastKnownGood: verified.nullable(),
  requests: z.array(operation).min(1).max(1024).readonly(),
}).strict().readonly();
export type HttpState = z.infer<typeof schema>;
export type HttpOperation = z.infer<typeof operation>;
export type HttpVerifiedRelease = z.infer<typeof verified>;
export type HttpNativeStep = z.infer<typeof step>;
export const terminalHttp = (phase: HttpOperation["phase"]) => phase === "succeeded" || phase === "failed" || phase === "cancelled";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Private coordinator state: references and proofs only, never materialized inputs. */
export const parseHttpState = (input: unknown, app: string, incarnation: string) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success || parsed.data.app !== app || parsed.data.incarnation !== incarnation) return err("invalid HTTP lifecycle state");
  const state = parsed.data;
  const id = (value: string) => {
    const sequence = Number(value.slice(incarnation.length + 1));
    return value.startsWith(incarnation + ":") && /^[1-9][0-9]*$/.test(value.slice(incarnation.length + 1)) && Number.isSafeInteger(sequence);
  };
  if (["request", "ticket", "action"].some((key) => new Set(state.requests.map((item) => key === "request" ? item.request : key === "ticket" ? item.ticket : item.action)).size !== state.requests.length) ||
    state.requests.filter((item) => !terminalHttp(item.phase)).length > 1) return err("duplicate or competing HTTP operation");
  if (state.requests.some((item, index) => !terminalHttp(item.phase) && index !== state.requests.length - 1)) return err("unsettled HTTP operation is not current");
  const valid = state.requests.every((item, index) => {
    if (!id(item.action) || !id(item.ticket) || (index > 0 && Number(item.action.split(":")[1]) <= Number(state.requests[index - 1]?.action.split(":")[1])) ||
      new Set(item.steps.map((step) => step.effect)).size !== item.steps.length ||
      item.steps.some((step) => (step.plan !== item.plan && step.plan !== item.previous?.plan) || (step.effect === "apply" ? step.plan !== item.plan || step.deadline !== item.deadline : step.deadline !== item.recoveryDeadline)) ||
      (item.recoveryDeadline !== null && (item.recoveryDeadline < item.deadline || item.recoveryDeadline - item.deadline > 90_000))) return false;
    if (item.previous !== null && !state.requests.slice(0, index).some((prior) => prior.phase === "succeeded" && same(prior.verified, item.previous))) return false;
    if (item.phase === "prepared" || item.phase === "admitted") return item.steps.length === 0 && item.verified === null && item.reason === null && item.recoveryDeadline === null;
    if (item.phase === "held") return item.reason !== null && item.verified === null;
    if (item.phase === "failed" || item.phase === "cancelled") return item.reason !== null && item.verified === null;
    if (item.reason !== null) return false;
    if (item.phase === "succeeded") return item.verified !== null && item.verified.plan === item.plan && item.verified.commit === item.commit && item.verified.action === item.action && item.verified.service === item.service && item.verified.verifiedAt <= item.deadline && item.steps.at(-1)?.effect === "apply";
    if (item.verified !== null) return false;
    if (item.phase === "applying" || item.phase === "verifying") return item.steps.length === 1 && item.steps[0]?.effect === "apply";
    return item.recoveryDeadline !== null;
  });
  const certified = (release: HttpVerifiedRelease | null) => release === null || state.requests.some((item) => item.phase === "succeeded" && same(item.verified, release));
  const latest = state.requests.at(-1);
  if (!valid || !certified(state.active) || !certified(state.lastKnownGood) || state.requested !== latest?.plan ||
    (state.desired !== null && !state.requests.some((item) => item.plan === state.desired))) return err("inconsistent HTTP lifecycle proofs");
  return ok<HttpState>(state);
};


export const parseHttpNativeStep = (input: unknown) => {
  const parsed = step.safeParse(input);
  return parsed.success ? ok<HttpNativeStep>(parsed.data) : err("invalid native HTTP intent");
};
