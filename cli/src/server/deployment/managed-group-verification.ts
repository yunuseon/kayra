import { createHash } from "node:crypto";
import { z } from "zod";
import { parseCheckTarget, containerCheckDigest } from "../../contracts/container-check.ts";
import type { ContainerCheckPort, CheckTargetPort } from "../../contracts/container-check.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import type { ManagedRoutedReadinessPort } from "../../contracts/routed-readiness.ts";
import { managedVerificationSnapshot } from "./managed-verification-source.ts";
import { describeManagedCheck } from "./managed-check-description.ts";
import { containerCheckExecution, parseContainerCheckExecution } from "./container-check-execution.ts";
import { convergedService } from "./service-convergence.ts";
import { routedHttp } from "./http-convergence.ts";
import { claimJournal } from "./journal-claim.ts";
import type { OperationJournal } from "./operation.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const native = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: positive }).strict().readonly();
const route = z.object({ app: z.string(), service: z.string(), incarnation: z.uuid(), action: z.string(), plan: digest, checkedAt: positive, status: z.enum(["ready", "unready", "unavailable"]) }).strict().readonly();
const schema = z.object({ version: z.literal(1), source: digest, app: z.string(), incarnation: z.uuid(), dataOwner: z.uuid(), plan: digest, run: z.uuid(), checkRun: z.uuid(), createdAt: positive, deadline: positive,
  phase: z.enum(["running", "verified", "held"]), reason: z.enum(["deadline", "runtime", "authorization", "check-failed", "check-unknown"]).nullable(),
  steps: z.array(z.object({ id: z.string().max(128), service: z.string().max(48), target: z.unknown().nullable(), plan: digest.nullable(), deadline: positive.nullable(), execution: z.unknown().nullable() }).strict().readonly()).max(128).readonly(),
  verified: z.object({ at: positive, observations: z.array(z.object({ name: z.string(), native, task: z.string().regex(/^[a-z0-9]{25}$/), routed: route.nullable() }).strict().readonly()).min(1).max(32).readonly() }).strict().readonly().nullable(),
}).strict().readonly();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
export const parseManagedGroupVerification = (input: unknown) => {
  const raw = schema.parse(input); const verified = raw.verified;
  const steps = Object.freeze(raw.steps.map((step) => {
    const target = step.target === null ? null : parseCheckTarget(step.target); if (target !== null && !target.ok) throw new Error("invalid managed check target evidence"); const reference = target === null ? null : target.value;
    const execution = step.execution === null ? null : parseContainerCheckExecution(step.execution);
    if ((step.plan === null) !== (reference === null) || (step.plan === null) !== (step.deadline === null) ||
      reference !== null && (reference.action.app !== raw.app || reference.action.incarnation !== raw.incarnation || reference.action.dataOwner !== raw.dataOwner || reference.action.service !== step.service) ||
      execution !== null && (execution.plan !== step.plan || execution.deadline !== step.deadline || execution.createdAt < raw.createdAt || execution.deadline > raw.deadline) ||
      verified !== null && (execution?.phase !== "complete" || execution.evidence?.exitCode !== 0 || execution.evidence.at > verified.at || !verified.observations.some((item) => item.name === step.service && item.task === reference?.task && item.native.id === reference.service))) throw new Error("managed check execution evidence disagrees");
    return Object.freeze({ ...step, target: reference, execution });
  }));
  if (raw.createdAt >= raw.deadline || raw.incarnation === raw.dataOwner || new Set(steps.map((step) => step.id)).size !== steps.length || (raw.phase === "held") !== (raw.reason !== null) || (raw.phase === "verified") !== (verified !== null) ||
    verified !== null && (verified.at < raw.createdAt || verified.at >= raw.deadline || new Set(verified.observations.map((item) => item.name)).size !== verified.observations.length)) throw new Error("inconsistent managed verification record");
  return Object.freeze({ ...raw, steps });
};
export type ManagedGroupVerification = ReturnType<typeof parseManagedGroupVerification>;
type Ports = { readonly now: () => number; readonly read: (digest: string) => Promise<string>; readonly retain: (bytes: string) => Promise<string>;
  readonly services: Readonly<Pick<ManagedWorkloadPort, "observeDesired">>; readonly readiness: ManagedRoutedReadinessPort; readonly checks?: (ContainerCheckPort & CheckTargetPort) | undefined;
  readonly authorize: (state: ManagedGroupVerification, effect: { readonly kind: "check"; readonly check: string; readonly effect: "create" | "start" } | { readonly kind: "verify" }) => Promise<boolean>;
};

/** Checks and final current-task/routed verification only. Unknown execs retain their pins and admission until the lifecycle owner fences their containers. */
export const managedGroupVerification = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "managed verification already has an owner");
  // eslint-disable-next-line functional/no-let -- serializes all private child views under the application owner
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- uncertain persistence requires reopening
  let poisoned = false;
  const serial = <T>(call: () => Promise<T>) => { const result = pending.then(() => { if (poisoned) throw new Error("managed verification write is uncertain; reopen"); return call(); }); pending = result.then(() => undefined, () => undefined); return result; };
  const children = new Map<string, ReturnType<typeof containerCheckExecution>>();
  const time = (minimum = 1) => { const now = ports.now(); if (!Number.isSafeInteger(now) || now < minimum) throw new Error("managed verification clock unavailable"); return now; };
  const load = async () => { const value = await journal.read(); return value === undefined ? undefined : parseManagedGroupVerification(value); };
  const required = async () => { const value = await load(); if (value === undefined) throw new Error("managed verification intent missing"); return value; };
  const write = async (input: ManagedGroupVerification) => { const value = parseManagedGroupVerification(input); try { await journal.write(value); } catch { poisoned = true; throw new Error("managed verification write is uncertain; reopen"); } return value; };
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => { const left = Math.min(10_000, deadline - time()); if (left <= 0) return undefined;
    const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, left); try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); } finally { clearTimeout(timer); }
  };
  const source = async (state: ManagedGroupVerification) => {
    const bytes = await bounded(state.deadline, () => ports.read(state.source)); if (bytes === undefined || hash(bytes) !== state.source) throw new Error("managed verification source unavailable"); const raw: unknown = JSON.parse(bytes); const snapshot = managedVerificationSnapshot(raw); const owner = snapshot.application.infrastructure.ownership;
    if (state.plan !== snapshot.plan || state.run !== snapshot.run || state.checkRun !== snapshot.checkRun || state.createdAt !== snapshot.createdAt || state.deadline !== snapshot.deadline || state.app !== owner.app || state.incarnation !== owner.incarnation || state.dataOwner !== owner.dataOwner ||
      !same(state.steps.map(({ id, service }) => Object.freeze({ id, service })), snapshot.application.rollout.checks.map(({ id, service }) => Object.freeze({ id, service }))) || state.steps.some((step) => { const target = step.target; return target !== null && !snapshot.witnesses.some((value) => value.name === step.service && same(value.action, target.action) && value.native.id === target.service); })) throw new Error("managed verification source integrity failed"); return snapshot;
  };
  const observation = async (state: ManagedGroupVerification, name: string, snapshot: Awaited<ReturnType<typeof source>>) => {
    const witness = snapshot.witnesses.find((item) => item.name === name); const service = snapshot.application.services[name]; if (witness === undefined || service === undefined) throw new Error("managed verification service missing");
    const observed = await bounded(state.deadline, () => ports.services.observeDesired(witness.action, service, snapshot.application));
    if (observed?.status !== "owned" || observed.id !== witness.native.id || observed.version < witness.native.version || !convergedService(witness.action, observed)) return undefined;
    const task = observed.tasks.find((task) => task.desired === "running" && task.state === "running"); return task === undefined ? undefined : Object.freeze({ witness, service, native: Object.freeze({ id: observed.id, version: observed.version }), task: task.id });
  };
  const hold = (state: ManagedGroupVerification, reason: "deadline" | "runtime" | "authorization" | "check-failed" | "check-unknown") => write({ ...state, phase: "held", reason, verified: null });
  const child = (id: string) => {
    const existing = children.get(id); if (existing !== undefined) return existing; const runtime = ports.checks; if (runtime === undefined) throw new Error("managed check capability unavailable");
    const owner = containerCheckExecution({ read: async () => (await required()).steps.find((step) => step.id === id)?.execution ?? undefined, write: async (value: unknown) => { const state = await required(); if (state.phase !== "running") throw new Error("managed check lost verification ownership"); const execution = parseContainerCheckExecution(value); await write({ ...state, steps: state.steps.map((step) => step.id === id ? Object.freeze({ ...step, execution }) : step) }); } },
      { ...ports, runtime, authorize: async (execution, plan, effect) => { const state = await required(); const step = state.steps.find((step) => step.id === id); const snapshot = await source(state); const current = step === undefined ? undefined : await observation(state, step.service, snapshot);
        return state.phase === "running" && step !== undefined && same(step.execution, execution) && step.plan === containerCheckDigest(plan) && plan.application === state.plan && plan.run === state.checkRun && current?.task === step.target?.task && plan.target.container === step.target?.container && await ports.authorize(state, { kind: "check", check: id, effect });
      } });
    // eslint-disable-next-line functional/immutable-data -- one private check owner per declared step
    children.set(id, owner); return owner;
  };
  return Object.freeze({
    prepare: (input: unknown) => {
      const snapshot = managedVerificationSnapshot(input); const bytes = JSON.stringify(snapshot.source); const owner = snapshot.application.infrastructure.ownership;
      if (snapshot.application.rollout.checks.length > 0 && ports.checks === undefined) return Promise.reject(new Error("managed check capability unavailable"));
      return serial(async () => { const previous = await load(); if (previous !== undefined) { if (previous.source !== hash(bytes)) throw new Error("managed verification intent conflicts"); return previous; }
        time(snapshot.createdAt); const state = parseManagedGroupVerification({ version: 1, source: hash(bytes), app: owner.app, incarnation: owner.incarnation, dataOwner: owner.dataOwner, plan: snapshot.plan, run: snapshot.run, checkRun: snapshot.checkRun, createdAt: snapshot.createdAt, deadline: snapshot.deadline, phase: "running", reason: null, verified: null,
          steps: snapshot.application.rollout.checks.map((check) => Object.freeze({ id: check.id, service: check.service, target: null, plan: null, deadline: null, execution: null })) });
        if (await bounded(Math.max(state.deadline, time() + 10_000), () => ports.retain(bytes)) !== state.source) throw new Error("managed verification snapshot retention failed"); return write(state);
      });
    },
    read: () => serial(load),
    tick: () => serial(async () => {
      const state = await required(); if (state.phase !== "running") return state; if (time(state.createdAt) >= state.deadline) return hold(state, "deadline"); const snapshot = await source(state);
      const step = state.steps.find((step) => step.execution?.phase !== "complete" || step.execution.evidence?.exitCode !== 0);
      if (step !== undefined) {
        if (step.execution?.phase === "held") return hold(state, step.execution.reason === "unknown-start" ? "check-unknown" : step.execution.reason === "deadline" ? "deadline" : "runtime");
        if (step.execution?.phase === "complete") return hold(state, "check-failed");
        if (step.plan === null) {
          const current = await observation(state, step.service, snapshot); const runtime = ports.checks; if (runtime === undefined) return hold(state, "runtime"); if (current === undefined) return state;
          const selected = await bounded(state.deadline, () => runtime.select(current.witness.action, current.native, current.task)); if (selected?.status !== "owned") return state;
          const target = parseCheckTarget(selected.target); if (!target.ok || !same(target.value.action, current.witness.action) || target.value.service !== current.native.id || target.value.task !== current.task) return hold(state, "runtime");
          const definition = snapshot.application.rollout.checks.find((check) => check.id === step.id); if (definition === undefined) throw new Error("managed check definition missing");
          const plan = describeManagedCheck(snapshot.application, state.checkRun, step.id, target.value, Math.min(state.deadline, time(state.createdAt) + (90 + definition.timeout_seconds) * 1000)); if (!plan.ok) throw new Error("managed check description unavailable");
          const digest = containerCheckDigest(plan.value); if (await bounded(state.deadline, () => ports.retain(JSON.stringify(plan.value))) !== digest) throw new Error("managed check plan retention failed");
          return write({ ...state, steps: state.steps.map((value) => value.id === step.id ? Object.freeze({ ...value, target: target.value, plan: digest, deadline: plan.value.deadline }) : value) });
        }
        if (step.execution === null) {
          const bytes = await bounded(state.deadline, () => ports.read(step.plan ?? "")); if (bytes === undefined || hash(bytes) !== step.plan || step.target === null || step.deadline === null) throw new Error("managed check description integrity failed"); const plan = describeManagedCheck(snapshot.application, state.checkRun, step.id, step.target, step.deadline);
          if (!plan.ok || JSON.stringify(plan.value) !== bytes) throw new Error("managed check description changed"); await child(step.id).prepare(plan.value); return required();
        }
        await child(step.id).tick(); return required();
      }
      // eslint-disable-next-line functional/prefer-immutable-types -- collects final observations before one synchronized certificate write
      const observations: NonNullable<ManagedGroupVerification["verified"]>["observations"][number][] = [];
      for (const witness of snapshot.witnesses) {
        const current = await observation(state, witness.name, snapshot); if (current === undefined) return state;
        if (state.steps.some((step) => step.service === witness.name && step.target?.task !== current.task)) return hold(state, "runtime");
        const routed = current.service.role === "http" ? await bounded(state.deadline, () => ports.readiness.check(witness.action, snapshot.application)) : null;
        const at = time(state.createdAt); if (at >= state.deadline) return hold(state, "deadline"); if (current.service.role === "http" && (routed === undefined || routed === null || !routedHttp(witness.action, routed, at))) return state;
        // eslint-disable-next-line functional/immutable-data -- evidence is published only after every workload/check/route passes
        observations.push(Object.freeze({ name: witness.name, native: current.native, task: current.task, routed: routed ?? null }));
      }
      if (await bounded(state.deadline, () => ports.authorize(state, { kind: "verify" })) !== true) return hold(state, "authorization"); const at = time(state.createdAt); if (at >= state.deadline) return hold(state, "deadline");
      if (observations.some((value) => { const routed = value.routed; return routed !== null && !snapshot.witnesses.some((witness) => witness.name === value.name && routedHttp(witness.action, routed, at)); })) return state;
      return write({ ...state, phase: "verified", verified: { at, observations } });
    }),
  });
};
