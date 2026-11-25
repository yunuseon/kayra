import { createHash } from "node:crypto";
import type { CheckContainerFencePort } from "../../contracts/check-container-fence.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import type { ManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import { serviceEffectAction } from "../../contracts/swarm-service.ts";
import type { OperationJournal } from "./operation.ts";
import { claimJournal } from "./journal-claim.ts";
import { managedServiceBarrier, parseManagedServiceBarrier } from "./managed-service-barrier.ts";
import { managedCheckCessationSource, managedCheckCessationNodes, managedCheckCessationPlan, parseManagedCheckCessation } from "./managed-check-cessation-state.ts";
import type { ManagedCheckCessation } from "./managed-check-cessation-state.ts";

type Ports = { readonly now: () => number; readonly read: (digest: string) => Promise<string>; readonly retain: (bytes: string) => Promise<string>;
  readonly services: Readonly<Pick<ManagedWorkloadPort, "observe" | "tombstone">>; readonly containers: CheckContainerFencePort;
  readonly authorize: (action: ManagedServiceAction | null) => Promise<boolean> };
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Stops only source-pinned consumer services. Container cessation is proved before any restoration can be authorized; no Exec result or remote application outcome is inferred. */
export const managedCheckCessation = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "managed check cessation already has an owner");
  // eslint-disable-next-line functional/no-let -- serializes one journal view and invalidates it on uncertain persistence
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- an uncertain write requires reopening
  let poisoned = false;
  const serial = <T>(call: () => Promise<T>) => { const next = pending.then(() => { if (poisoned) throw new Error("managed check cessation write is uncertain; reopen"); return call(); }); pending = next.then(() => undefined, () => undefined); return next; };
  const time = () => { const now = ports.now(); if (!Number.isSafeInteger(now) || now < 1) throw new Error("managed check cessation clock unavailable"); return now; };
  const load = async () => { const raw = await journal.read(); return raw === undefined ? undefined : parseManagedCheckCessation(raw); };
  const required = async () => { const state = await load(); if (state === undefined) throw new Error("managed check cessation intent missing"); return state; };
  const write = async (input: ManagedCheckCessation) => { const state = parseManagedCheckCessation(input); try { await journal.write(state); } catch { poisoned = true; throw new Error("managed check cessation write is uncertain; reopen"); } return state; };
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => { const left = Math.min(10_000, deadline - time()); if (left <= 0) return undefined; const expired = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { expired.resolve(undefined); }, left);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), expired.promise]); } finally { clearTimeout(timer); }
  };
  const source = async (state: ManagedCheckCessation, deadline = time() + 10_000) => {
    const bytes = await bounded(deadline, () => ports.read(state.source)); if (bytes === undefined || hash(bytes) !== state.source) throw new Error("managed check cessation source unavailable");
    const value = managedCheckCessationSource(JSON.parse(bytes));
    if (bytes !== JSON.stringify(value) || managedCheckCessationPlan(value) !== state.plan || value.run !== state.run || value.action !== state.action || value.createdAt !== state.createdAt || value.deadline !== state.deadline || !same(managedCheckCessationNodes(value), state.nodes.map(({ name, plan, checks }) => Object.freeze({ name, plan, checks })))) throw new Error("managed check cessation source binding disagrees");
    return value;
  };
  const barriers = new Map<string, ReturnType<typeof managedServiceBarrier>>();
  const barrier = (name: string) => {
    const existing = barriers.get(name); if (existing !== undefined) return existing;
    const child = managedServiceBarrier({ read: async () => (await required()).nodes.find((node) => node.name === name)?.barrier ?? undefined,
      write: async (input: unknown) => { const state = await required(); if (state.phase !== "fencing") throw new Error("managed check cessation lost its writer fence"); const value = parseManagedServiceBarrier(input); await write({ ...state, nodes: state.nodes.map((node) => node.name === name ? { ...node, barrier: value } : node) }); },
    }, { ...ports, runtime: ports.services, authorize: (_state, action) => ports.authorize(action) });
    // eslint-disable-next-line functional/immutable-data -- one child owns each private barrier view
    barriers.set(name, child); return child;
  };
  const hold = (state: ManagedCheckCessation, reason: "runtime" | "deadline" | "authorization") => write({ ...state, phase: "held", reason, finishedAt: null });
  return Object.freeze({
    prepare: (input: unknown) => serial(async () => {
      const value = managedCheckCessationSource(input); const bytes = JSON.stringify(value); const digest = hash(bytes); const existing = await load();
      if (existing !== undefined) { if (existing.source !== digest) throw new Error("managed check cessation intent conflicts"); await source(existing); return existing; }
      if (time() < value.createdAt || time() >= value.deadline || await bounded(value.deadline, () => ports.retain(bytes)) !== digest) throw new Error("managed check cessation preparation expired or unavailable");
      if (time() >= value.deadline) throw new Error("managed check cessation preparation expired");
      return write({ version: 1, source: digest, plan: managedCheckCessationPlan(value), run: value.run, action: value.action, createdAt: value.createdAt, deadline: value.deadline, phase: "fencing", reason: null, finishedAt: null, nodes: managedCheckCessationNodes(value).map((node) => Object.freeze({ ...node, barrier: null, proofs: Object.freeze([]) })) });
    }),
    read: () => serial(load),
    tick: () => serial(async () => {
      const state = await required(); if (state.phase !== "fencing") return state; if (time() >= state.deadline) return hold(state, "deadline"); const value = await source(state, state.deadline);
      if (await bounded(state.deadline, () => ports.authorize(null)) !== true) return hold(state, "authorization");
      for (const node of state.nodes) {
        if (node.barrier === null) {
          const service = value.application.services[node.name]; if (service === undefined) throw new Error("managed check cessation service missing");
          const prior = Object.freeze(node.checks.map((item) => item.native).filter((item, index, all) => all.findIndex((other) => same(item, other)) === index).toSorted((a, b) => a.version - b.version));
          await barrier(node.name).prepare(service, { app: service.owner.app, incarnation: service.owner.incarnation, dataOwner: service.owner.dataOwner, service: node.name, action: state.action, effect: "remove", plan: node.plan, deadline: state.deadline }, prior, "checks"); return required();
        }
        if (node.barrier.phase === "held") return hold(state, "runtime");
        if (node.barrier.phase !== "complete") { await barrier(node.name).tick(); return required(); }
        const target = node.checks.find((check) => !node.proofs.some((item) => item.container === check.target.container)); if (target === undefined) continue;
        const currentBarrier = node.barrier; const step = currentBarrier.steps.at(-1); const proof = currentBarrier.proof; if (step?.effect !== "scrub" || proof === null) throw new Error("managed check cessation barrier missing");
        const observed = await bounded(state.deadline, () => ports.containers.observe({ target: target.target, native: proof.native, barrier: { ...currentBarrier.action, effect: "scrub", action: serviceEffectAction(currentBarrier.action.action, "scrub", step.attempt) } }));
        if (observed?.status === "foreign") return hold(state, "runtime"); if (observed?.status !== "fenced") return time() >= state.deadline ? hold(state, "deadline") : state;
        if (observed.native.id !== target.target.service || observed.native.version < proof.native.version || observed.checkedAt < proof.at) return hold(state, "runtime");
        if (time() >= state.deadline || observed.checkedAt < state.createdAt || observed.checkedAt > time()) return hold(state, "deadline");
        return write({ ...state, nodes: state.nodes.map((item) => item.name === node.name ? { ...item, proofs: [...item.proofs, { container: target.target.container, kind: observed.kind, native: observed.native, checkedAt: observed.checkedAt }] } : item) });
      }
      if (time() >= state.deadline) return hold(state, "deadline"); return write({ ...state, phase: "complete", finishedAt: time() });
    }),
  });
};
