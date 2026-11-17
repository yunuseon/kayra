import type { ManagedChecksPort } from "../../contracts/container-check.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import type { ManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { ManagedRoutedReadinessPort } from "../../contracts/routed-readiness.ts";
import { parseManagedServiceCompensation, managedServiceCompensation } from "./managed-service-compensation.ts";
import { managedRecoverySnapshot, managedRecoveryDigest } from "./managed-recovery-description.ts";
import { clearedService, convergedService } from "./service-convergence.ts";
import { routedHttp } from "./http-convergence.ts";
import { claimJournal } from "./journal-claim.ts";
import type { OperationJournal } from "./operation.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const native = z.object({ id: z.string().regex(/^[a-z0-9]{25}$/), version: positive }).strict().readonly();
const routed = z.object({ app: z.string(), service: z.string(), incarnation: z.uuid(), action: z.string(), plan: digest, checkedAt: positive, status: z.enum(["ready", "unready", "unavailable"]) }).strict().readonly();
const schema = z.object({ version: z.literal(1), app: z.string().max(48), incarnation: z.uuid(), dataOwner: z.uuid(), run: z.uuid(), action: z.string(), plan: digest, previous: digest.nullable(), description: digest, source: digest,
  createdAt: positive, deadline: positive, cursor: z.number().int().min(0).max(31), phase: z.enum(["recovering", "verified", "held"]), reason: z.enum(["deadline", "runtime", "authorization"]).nullable(), verifiedAt: positive.nullable(),
  nodes: z.array(z.object({ name: z.string().max(48), plan: digest, baseline: native.nullable(), prior: z.array(native).max(24).readonly(), child: z.unknown().nullable(), routed: routed.nullable() }).strict().readonly()).max(32).readonly(),
}).strict().readonly();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
export const parseManagedGroupCompensation = (input: unknown) => {
  const raw = schema.parse(input); const at = raw.verifiedAt;
  const nodes = Object.freeze(raw.nodes.map((node) => {
    const child = node.child === null ? null : parseManagedServiceCompensation(node.child);
    if (child !== null && (child.action.app !== raw.app || child.action.incarnation !== raw.incarnation || child.action.dataOwner !== raw.dataOwner || child.action.service !== node.name || child.action.action !== raw.action || child.action.plan !== node.plan || child.action.deadline !== raw.deadline || child.createdAt < raw.createdAt || child.candidate !== raw.plan || child.previous !== raw.previous || !same(child.baseline, node.baseline) || !same(child.prior, node.prior)) ||
      node.routed !== null && (at === null || child?.phase !== "complete" || child.attempts.at(-1) === undefined || !routedHttp(child.attempts.at(-1)?.action ?? child.action, node.routed, at))) throw new Error("managed group recovery child evidence disagrees");
    return Object.freeze({ ...node, child });
  }));
  if (raw.deadline !== raw.createdAt + 90_000 || raw.incarnation === raw.dataOwner || !new RegExp(`^${raw.incarnation}:[1-9][0-9]*$`).test(raw.action) || !Number.isSafeInteger(Number(raw.action.split(":")[1])) ||
    new Set(nodes.map((node) => node.name)).size !== nodes.length || (raw.phase === "held") !== (raw.reason !== null) || (raw.phase === "verified") !== (at !== null) ||
    at !== null && (at < raw.createdAt || at >= raw.deadline || nodes.some((node) => node.child?.phase !== "complete" || (node.child.proof?.at ?? Infinity) > at))) throw new Error("inconsistent managed group recovery");
  return Object.freeze({ ...raw, nodes });
};
export type ManagedGroupCompensation = ReturnType<typeof parseManagedGroupCompensation>;
type Ports = { readonly checks?: ManagedChecksPort | undefined; readonly now: () => number; readonly read: (digest: string) => Promise<string>; readonly retain: (bytes: string) => Promise<string>;
  readonly services: ManagedWorkloadPort; readonly readiness: ManagedRoutedReadinessPort;
  /** Root holds the exclusive lifecycle fence, settled migration outcomes and unchanged pending peak reservation. */
  readonly authorize: (state: ManagedGroupCompensation, effect: { readonly kind: "service"; readonly action: ManagedServiceAction } | { readonly kind: "verify" }) => Promise<boolean>;
};

/** Whole application compensation certificate. The root alone settles admission, publishes outcomes and promotes releases. */
export const managedGroupCompensation = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "managed group recovery already has an owner");
  // eslint-disable-next-line functional/no-let -- all child views share one serialized parent writer
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- an uncertain synchronization invalidates the live handle
  let poisoned = false;
  const serial = <T>(call: () => Promise<T>) => { const result = pending.then(() => { if (poisoned) throw new Error("managed group recovery write is uncertain; reopen"); return call(); }); pending = result.then(() => undefined, () => undefined); return result; };
  const children = new Map<string, ReturnType<typeof managedServiceCompensation>>();
  const time = (minimum = 1) => { const now = ports.now(); if (!Number.isSafeInteger(now) || now < minimum) throw new Error("managed group recovery clock unavailable"); return now; };
  const load = async () => { const value = await journal.read(); return value === undefined ? undefined : parseManagedGroupCompensation(value); };
  const required = async () => { const value = await load(); if (value === undefined) throw new Error("managed group recovery intent missing"); return value; };
  const write = async (input: ManagedGroupCompensation) => { const state = parseManagedGroupCompensation(input); try { await journal.write(state); } catch { poisoned = true; throw new Error("managed group recovery write is uncertain; reopen"); } return state; };
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => { const left = deadline - time(); if (left <= 0) return undefined;
    const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, left);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); } finally { clearTimeout(timer); }
  };
  const source = async (state: ManagedGroupCompensation) => {
    const bytes = await bounded(Math.min(state.deadline, time() + 10_000), () => ports.read(state.source)); if (bytes === undefined || hash(bytes) !== state.source) throw new Error("managed group recovery source unavailable");
    const raw: unknown = JSON.parse(bytes); const snapshot = managedRecoverySnapshot(raw); const description = snapshot.description;
    if (managedRecoveryDigest(description) !== state.description || description.app !== state.app || description.incarnation !== state.incarnation || description.dataOwner !== state.dataOwner || description.run !== state.run || description.action !== state.action || description.plan !== state.plan || description.previous !== state.previous || !same(description.nodes, state.nodes.map(({ name, plan, baseline, prior }) => Object.freeze({ name, plan, baseline, prior })))) throw new Error("managed group recovery source integrity failed");
    return snapshot;
  };
  const hold = (state: ManagedGroupCompensation, reason: "deadline" | "runtime" | "authorization") => write({ ...state, phase: "held", reason, verifiedAt: null, nodes: state.nodes.map((node) => Object.freeze({ ...node, routed: null })) });
  const dependencies = async (state: ManagedGroupCompensation, name: string, snapshot: Awaited<ReturnType<typeof source>>) => {
    const before = snapshot.source.previous; const service = before?.services[name];
    if (service === undefined || before === null) return !Object.values(snapshot.source.candidate.services).some((spec) => spec.dependencies.some((dependency) => dependency.service === name) && state.nodes.some((node) => node.name === spec.service && node.child?.phase !== "complete"));
    for (const dependency of service.dependencies) {
      const retained = snapshot.description.retained.find((value) => value.name === dependency.service); const node = state.nodes.find((value) => value.name === dependency.service);
      const original = snapshot.description.baselines.find((value) => value.name === dependency.service); const restored = node?.child?.attempts.at(-1);
      const action = retained?.action ?? restored?.action ?? original?.action; const spec = before.services[dependency.service]; if (action === undefined || spec === undefined) return false;
      const observed = await bounded(Math.min(state.deadline, time() + 10_000), () => ports.services.observeDesired(action, spec, before));
      if (observed === undefined || !convergedService(action, observed) || observed.status !== "owned" || observed.id !== (retained?.native.id ?? original?.native.id)) return false;
    }
    return true;
  };
  const child = (name: string) => {
    const existing = children.get(name); if (existing !== undefined) return existing;
    const owner = managedServiceCompensation({ read: async () => (await required()).nodes.find((node) => node.name === name)?.child ?? undefined, write: async (input: unknown) => { const state = await required(); if (state.phase !== "recovering") throw new Error("managed recovery child lost ownership"); const value = parseManagedServiceCompensation(input); await write({ ...state, nodes: state.nodes.map((node) => node.name === name ? { ...node, child: value } : node) }); } },
      { ...ports, authorize: async (value, action) => { const state = await required(); const snapshot = await source(state); return state.phase === "recovering" && same(state.nodes.find((node) => node.name === name)?.child, value) && await dependencies(state, name, snapshot) && ports.authorize(state, { kind: "service", action }); } });
    // eslint-disable-next-line functional/immutable-data -- one private owner per service compensation slot
    children.set(name, owner); return owner;
  };
  return Object.freeze({
    prepare: (input: unknown, startedAt?: number) => {
      const snapshot = managedRecoverySnapshot(input); const description = snapshot.description; const bytes = JSON.stringify(snapshot.source);
      if (startedAt !== undefined && (!Number.isSafeInteger(startedAt) || startedAt < 1)) return Promise.reject(new Error("invalid managed recovery phase entry"));
      if (snapshot.source.previous !== null && ports.services.fence === undefined) return Promise.reject(new Error("managed group recovery requires metadata fencing capability"));
      if (ports.checks === undefined && [snapshot.source.candidate, ...(snapshot.source.previous === null ? [] : [snapshot.source.previous])].some((plan) => plan.rollout.checks.length !== 0 || Object.values(plan.services).some((service) => service.overlap === "coordinated"))) return Promise.reject(new Error("managed group recovery checks capability unavailable"));
      return serial(async () => { const existing = await load(); if (existing !== undefined) { if (existing.description !== managedRecoveryDigest(description) || existing.source !== hash(bytes) || startedAt !== undefined && existing.createdAt !== startedAt) throw new Error("managed group recovery intent conflicts"); return existing; }
        const now = time(); const at = startedAt ?? now; if (at > now || now >= at + 90_000) throw new Error("managed recovery phase entry is future or expired");
        const state = parseManagedGroupCompensation({ version: 1, app: description.app, incarnation: description.incarnation, dataOwner: description.dataOwner, run: description.run, action: description.action, plan: description.plan, previous: description.previous, description: managedRecoveryDigest(description), source: hash(bytes), createdAt: at, deadline: at + 90_000, cursor: 0, phase: "recovering", reason: null, verifiedAt: null, nodes: description.nodes.map((node) => Object.freeze({ ...node, child: null, routed: null })) });
        if (await bounded(state.deadline, () => ports.retain(bytes)) !== state.source || time(state.createdAt) >= state.deadline) throw new Error("managed group recovery snapshot retention failed"); return write(state);
      });
    },
    read: () => serial(load),
    tick: () => serial(async () => {
      const state = await required(); if (state.phase !== "recovering") return state; if (time(state.createdAt) >= state.deadline) return hold(state, "deadline"); const snapshot = await source(state);
      if (state.nodes.every((node) => node.child?.phase === "complete")) {
        // eslint-disable-next-line functional/prefer-immutable-types -- evidence is collected locally before one verified journal write
        const nodes: ManagedGroupCompensation["nodes"][number][] = [];
        for (const retained of snapshot.description.retained) {
          const plan = snapshot.source.previous; const spec = plan?.services[retained.name]; if (plan === null || spec === undefined) throw new Error("managed recovery retained plan missing");
          const observed = await bounded(Math.min(state.deadline, time() + 10_000), () => ports.services.observeDesired(retained.action, spec, plan));
          if (observed?.status !== "owned" || observed.id !== retained.native.id || observed.version < retained.native.version || !convergedService(retained.action, observed)) return hold(state, "runtime");
        }
        for (const node of state.nodes) {
          const before = snapshot.source.previous; const spec = before?.services[node.name]; const proof = node.child?.proof; if (proof === null || proof === undefined) throw new Error("managed group compensation proof missing");
          if (spec === undefined || before === null) {
            const observed = await bounded(Math.min(state.deadline, time() + 10_000), () => ports.services.observe({ app: state.app, incarnation: state.incarnation, dataOwner: state.dataOwner, service: node.name }));
            if (observed?.status !== "owned" || !clearedService(observed) || observed.id !== proof.native.id || observed.version < proof.native.version || ![null, "completed", "rollback_completed"].includes(observed.update)) return hold(state, "runtime");
            // eslint-disable-next-line functional/immutable-data -- gathers checked evidence before publication
            nodes.push(node); continue;
          }
          const action = node.child?.attempts.at(-1)?.action; if (action === undefined) throw new Error("managed restored action missing");
          const observed = await bounded(Math.min(state.deadline, time() + 10_000), () => ports.services.observeDesired(action, spec, before)); if (observed?.status !== "owned" || observed.id !== proof.native.id || observed.version < proof.native.version || !convergedService(action, observed)) return hold(state, "runtime");
          const routed = spec.role === "http" ? await bounded(state.deadline, () => ports.readiness.check(action, before)) : null;
          const at = time(state.createdAt); if (at >= state.deadline) return hold(state, "deadline"); if (spec.role === "http" && (routed === undefined || routed === null || !routedHttp(action, routed, at))) return state;
          // eslint-disable-next-line functional/immutable-data -- gathers checked evidence before publication
          nodes.push(Object.freeze({ ...node, routed: routed ?? null }));
        }
        if (await bounded(state.deadline, () => ports.authorize(state, { kind: "verify" })) !== true) return hold(state, "authorization");
        const at = time(state.createdAt); if (at >= state.deadline) return hold(state, "deadline");
        if (nodes.some((node) => node.routed !== null && (node.child === null || !routedHttp(node.child.attempts.at(-1)?.action ?? node.child.action, node.routed, at)))) return state;
        return write({ ...state, nodes, phase: "verified", verifiedAt: at });
      }
      const pending = state.nodes.map((node, index) => Object.freeze({ node, index })).filter(({ node }) => node.child?.phase !== "complete"); const selected = pending.find(({ index }) => index >= state.cursor) ?? pending[0]; if (selected === undefined) throw new Error("managed recovery scheduler inconsistent");
      const current = await write({ ...state, cursor: (selected.index + 1) % Math.max(1, state.nodes.length) }); const node = selected.node;
      if (node.child?.phase === "held") return hold(current, "runtime");
      if (!await dependencies(current, node.name, snapshot)) return current;
      if (node.child === null) { await child(node.name).prepare(snapshot.source.candidate, snapshot.source.previous, { app: current.app, incarnation: current.incarnation, dataOwner: current.dataOwner, service: node.name, action: current.action, plan: node.plan, effect: "restore", deadline: current.deadline }, node.baseline, node.prior); return required(); }
      await child(node.name).tick(); return required();
    }),
  });
};
