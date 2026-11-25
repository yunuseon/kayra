import { createHash } from "node:crypto";
import type { CheckContainerFencePort } from "../../contracts/check-container-fence.ts";
import type { JobPort } from "../../contracts/one-shot-job.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import type { ManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import { serviceEffectAction } from "../../contracts/swarm-service.ts";
import { claimJournal } from "./journal-claim.ts";
import type { OperationJournal } from "./operation.ts";
import { managedForwardEffectSource, managedForwardEffectNodes } from "./managed-forward-effect-source.ts";
import type { ManagedForwardEffectSource } from "./managed-forward-effect-source.ts";
import { parseManagedForwardEffects } from "./managed-forward-effect-state.ts";
import type { ManagedForwardEffects } from "./managed-forward-effect-state.ts";
import { managedServiceBarrier, parseManagedServiceBarrier } from "./managed-service-barrier.ts";
import { verifyManagedRecoveryJobs } from "./managed-recovery-safety.ts";
import { clearedService } from "./service-convergence.ts";

type Ports = { readonly now: () => number; readonly read: (digest: string) => Promise<string>; readonly retain: (bytes: string) => Promise<string>;
  readonly services: Readonly<Pick<ManagedWorkloadPort, "observe" | "tombstone">>; readonly containers: CheckContainerFencePort; readonly jobs: Readonly<Pick<JobPort, "observe">>;
  /** Parent holds the reserved continuation action, the old pending lease and the unchanged held checkpoint. A build selection alone is insufficient. */
  readonly authorize: (source: ManagedForwardEffectSource, action: ManagedServiceAction | null) => Promise<boolean> };
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Private consumer cleanup only. Does not start a successor, stop retained data, infer Exec outcomes or release admission. */
export const managedForwardEffects = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "forward effects already have an owner");
  // eslint-disable-next-line functional/no-let -- one writer serializes child views and invalidates uncertain persistence
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- synchronization uncertainty requires a fresh handle
  let poisoned = false;
  const serial = <T>(call: () => Promise<T>) => { const result = pending.then(() => { if (poisoned) throw new Error("forward effect write uncertain; reopen"); return call(); }); pending = result.then(() => undefined, () => undefined); return result; };
  const time = () => { const now = ports.now(); if (!Number.isSafeInteger(now) || now < 1) throw new Error("forward effect clock unavailable"); return now; };
  const load = async () => { const raw = await journal.read(); return raw === undefined ? undefined : parseManagedForwardEffects(raw); };
  const required = async () => { const value = await load(); if (value === undefined) throw new Error("forward effect intent missing"); return value; };
  const write = async (input: ManagedForwardEffects) => { const value = parseManagedForwardEffects(input); try { await journal.write(value); } catch { poisoned = true; throw new Error("forward effect write uncertain; reopen"); } return value; };
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => { const left = Math.min(10_000, deadline - time()); if (left <= 0) return undefined;
    const expired = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { expired.resolve(undefined); }, left);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), expired.promise]); } finally { clearTimeout(timer); }
  };
  const source = async (state: ManagedForwardEffects, deadline = time() + 10_000) => {
    const bytes = await bounded(deadline, () => ports.read(state.source)); if (bytes === undefined || hash(bytes) !== state.source) throw new Error("forward effect source unavailable");
    const value = managedForwardEffectSource(JSON.parse(bytes)); const owner = value.baseline.state.owner;
    const nodes = managedForwardEffectNodes(value).map(({ name, plan, prior, waitFor, checks }) => Object.freeze({ name, plan, prior, waitFor, checks }));
    if (bytes !== JSON.stringify(value) || value.request.run !== state.run || value.request.action !== state.action || value.request.createdAt !== state.createdAt || value.deadline !== state.deadline || owner.app !== state.app || owner.incarnation !== state.incarnation || owner.dataOwner !== state.dataOwner || !same(nodes, state.nodes.map(({ name, plan, prior, waitFor, checks }) => Object.freeze({ name, plan, prior, waitFor, checks })))) throw new Error("forward effect source binding disagrees");
    return value;
  };
  const guard = async (state: ManagedForwardEffects, value: ManagedForwardEffectSource, action: ManagedServiceAction | null) => {
    const prefix = value.baseline.state.operation.preparation;
    return await bounded(state.deadline, async () => { if (prefix !== null) await verifyManagedRecoveryJobs(value.baseline.source, prefix, { read: ports.read, native: ports.jobs }); return true; }) === true && await bounded(state.deadline, () => ports.authorize(value, action)) === true && time() < state.deadline;
  };
  const children = new Map<string, ReturnType<typeof managedServiceBarrier>>();
  const child = (name: string) => {
    const existing = children.get(name); if (existing !== undefined) return existing;
    const owner = managedServiceBarrier({ read: async () => (await required()).nodes.find((node) => node.name === name)?.barrier ?? undefined,
      write: async (input) => { const state = await required(); if (state.phase !== "fencing") throw new Error("forward effect child lost ownership"); const barrier = parseManagedServiceBarrier(input); await write({ ...state, nodes: state.nodes.map((node) => node.name === name ? { ...node, barrier } : node) }); },
    }, { ...ports, runtime: { observe: ports.services.observe, tombstone: async (...args) => {
      const state = await required(); if (state.phase !== "fencing" || !await guard(state, await source(state, state.deadline), args[0])) return "refused";
      return ports.services.tombstone(...args);
    } }, authorize: async (_, action) => { const state = await required(); return state.phase === "fencing" && guard(state, await source(state, state.deadline), action); } });
    // eslint-disable-next-line functional/immutable-data -- one owned view per private child
    children.set(name, owner); return owner;
  };
  const hold = (state: ManagedForwardEffects, reason: "runtime" | "deadline" | "authorization") => write({ ...state, phase: "held", reason, finishedAt: null });
  return Object.freeze({
    prepare: (input: unknown) => serial(async () => {
      const value = managedForwardEffectSource(input); const bytes = JSON.stringify(value); const identity = hash(bytes); const previous = await load();
      if (previous !== undefined) { if (previous.source !== identity) throw new Error("forward effect intent conflicts"); await source(previous); return previous; }
      if (time() < value.request.createdAt || time() >= value.deadline || await bounded(value.deadline, () => ports.retain(bytes)) !== identity || time() >= value.deadline) throw new Error("forward effect preparation expired or unavailable");
      const nodes = managedForwardEffectNodes(value); const owner = value.baseline.state.owner;
      return write({ version: 1, source: identity, run: value.request.run, action: value.request.action, app: owner.app, incarnation: owner.incarnation, dataOwner: owner.dataOwner, createdAt: value.request.createdAt, deadline: value.deadline, phase: "fencing", reason: null, finishedAt: null, cursor: 0,
        nodes: nodes.map(({ name, plan, prior, waitFor, checks }) => Object.freeze({ name, plan, prior, waitFor, checks, barrier: null, proofs: Object.freeze([]) })) });
    }),
    read: () => serial(load),
    tick: () => serial(async () => {
      const state = await required(); const value = await source(state); if (time() < state.createdAt) throw new Error("forward effect clock moved backwards"); if (state.phase !== "fencing") return state; if (time() >= state.deadline) return hold(state, "deadline");
      if (!await guard(state, value, null)) return hold(state, time() >= state.deadline ? "deadline" : "authorization");
      const unfinished = state.nodes.filter((node) => node.barrier?.phase !== "complete");
      if (unfinished.some((node) => node.barrier?.phase === "held")) return hold(state, "runtime");
      const eligible = unfinished.filter((node) => node.waitFor.every((name) => state.nodes.find((other) => other.name === name)?.barrier?.phase === "complete"));
      const selected = [...state.nodes.slice(state.cursor), ...state.nodes.slice(0, state.cursor)].find((node) => eligible.some((item) => item.name === node.name));
      if (selected !== undefined) {
        await write({ ...state, cursor: (state.nodes.findIndex((node) => node.name === selected.name) + 1) % state.nodes.length });
        if (selected.barrier === null) { const node = managedForwardEffectNodes(value).find((item) => item.name === selected.name); if (node === undefined) throw new Error("forward effect service missing");
          await child(selected.name).prepare(node.service, { app: state.app, incarnation: state.incarnation, dataOwner: state.dataOwner, service: selected.name, action: state.action, effect: "remove", plan: node.plan, deadline: state.deadline }, node.prior, "quiesce");
        } else await child(selected.name).tick(); return required();
      }
      if (unfinished.length !== 0) throw new Error("forward effect dependency scheduler inconsistent");
      for (const node of state.nodes) {
        const barrier = node.barrier; const proof = barrier?.proof; const step = barrier?.steps.at(-1); if (barrier === null || proof === undefined || proof === null || step?.effect !== "scrub") throw new Error("forward effect barrier missing");
        const target = node.checks.find((check) => !node.proofs.some((item) => item.container === check.target.container));
        if (target !== undefined) {
          const observed = await bounded(state.deadline, () => ports.containers.observe({ target: target.target, native: proof.native, barrier: { ...barrier.action, effect: "scrub", action: serviceEffectAction(barrier.action.action, "scrub", step.attempt) } }));
          if (observed?.status === "foreign") return hold(state, "runtime"); if (observed?.status !== "fenced") return time() >= state.deadline ? hold(state, "deadline") : state;
          if (observed.native.id !== target.target.service || observed.native.version < proof.native.version || observed.checkedAt < proof.at || observed.checkedAt > time()) return hold(state, "runtime");
          if (time() >= state.deadline) return hold(state, "deadline");
          return write({ ...state, nodes: state.nodes.map((item) => item.name === node.name ? { ...item, proofs: [...item.proofs, { container: target.target.container, kind: observed.kind, native: observed.native, checkedAt: observed.checkedAt }] } : item) });
        }
        const observed = await bounded(state.deadline, () => ports.services.observe({ app: state.app, incarnation: state.incarnation, dataOwner: state.dataOwner, service: node.name }));
        if (observed === undefined || observed.status === "unavailable") return time() >= state.deadline ? hold(state, "deadline") : state;
        if (observed.status !== "owned" || !clearedService(observed) || observed.id !== proof.native.id || observed.version < proof.native.version || observed.action !== serviceEffectAction(barrier.action.action, "scrub", step.attempt) || observed.effect !== "scrub" || observed.plan !== node.plan) return hold(state, "runtime");
      }
      if (!await guard(state, value, null)) return hold(state, time() >= state.deadline ? "deadline" : "authorization");
      return time() >= state.deadline ? hold(state, "deadline") : write({ ...state, phase: "complete", finishedAt: time() });
    }),
  });
};
