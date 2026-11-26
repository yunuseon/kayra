import { createHash } from "node:crypto";
import { z } from "zod";
import type { CheckContainerFencePort } from "../../contracts/check-container-fence.ts";
import type { JobCleanupPort } from "../../contracts/job-cleanup.ts";
import { parseJobCleanupState } from "../../contracts/job-cleanup.ts";
import { jobPlanDigest, parseJobPlan } from "../../contracts/one-shot-job.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import type { ManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import { serviceEffectAction } from "../../contracts/swarm-service.ts";
import { clearedService } from "./service-convergence.ts";
import { claimJournal } from "./journal-claim.ts";
import { jobCleanup } from "./job-cleanup.ts";
import { managedServiceBarrier, parseManagedServiceBarrier } from "./managed-service-barrier.ts";
import type { managedRemovalInventory } from "./managed-removal-inventory.ts";
import type { OperationJournal } from "./operation.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const checkProof = z.object({
  container: digest, service: z.string().max(48), version: time, at: time, kind: z.enum(["stopped", "absent"]),
}).strict().readonly();
const schema = z.object({
  version: z.literal(1), inventory: digest, createdAt: time, deadline: time,
  phase: z.enum(["fencing-jobs", "stopping", "complete", "held"]),
  reason: z.enum(["deadline", "authority", "job", "service", "check"]).nullable(),
  finishedAt: time.nullable(), checks: z.array(checkProof).max(256).readonly(),
  jobs: z.array(z.object({ artifact: digest, child: z.unknown().nullable() }).strict().readonly()).max(2048).readonly(),
  services: z.array(z.object({ name: z.string().max(48), barrier: z.unknown().nullable() }).strict().readonly()).max(96).readonly(),
}).strict().readonly();
export const managedRemovalInventoryDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type ManagedRemovalInventory = Awaited<ReturnType<typeof managedRemovalInventory>>;
export type ManagedRemovalEffectsPorts = {
  readonly now: () => number;
  readonly read: (digest: string) => Promise<string>;
  readonly retain: (bytes: string) => Promise<string>;
  readonly services: Readonly<Pick<ManagedWorkloadPort, "observe" | "tombstone">>;
  readonly jobs: JobCleanupPort;
  readonly containers: CheckContainerFencePort;
  readonly authorize: (intent: ManagedRemovalInventory["intent"], action: ManagedServiceAction | null) => Promise<boolean>;
};

/** Removal stops application effects and retains native name barriers. This owner cannot delete volumes or settle admission. */
export const managedRemovalEffects = (journal: OperationJournal, inventory: ManagedRemovalInventory, ports: ManagedRemovalEffectsPorts) => {
  claimJournal(journal, "managed removal effects already have an owner");
  const identity = managedRemovalInventoryDigest(inventory);
  const intent = inventory.intent;
  // eslint-disable-next-line functional/no-let -- serializes the parent and its private child journal views
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- reopen after an uncertain synchronization result
  let poisoned = false;
  const serial = <T>(call: () => Promise<T>) => {
    const next = pending.then(() => { if (poisoned) throw new Error("removal journal write uncertain; reopen"); return call(); });
    pending = next.then(() => undefined, () => undefined); return next;
  };
  const parse = (input: unknown) => {
    const raw = schema.parse(input);
    if (raw.inventory !== identity || raw.createdAt < intent.createdAt || raw.deadline !== raw.createdAt + 90_000 ||
      (raw.phase === "held") !== (raw.reason !== null) || (raw.phase === "complete") !== (raw.finishedAt !== null) ||
      raw.finishedAt !== null && (raw.finishedAt < raw.createdAt || raw.finishedAt >= raw.deadline) ||
      JSON.stringify(raw.jobs.map((item) => item.artifact)) !== JSON.stringify(inventory.jobs) ||
      JSON.stringify(raw.services.map((item) => item.name)) !== JSON.stringify(inventory.services.map((item) => item.name))) throw new Error("removal journal does not match its inventory");
    const jobs = Object.freeze(raw.jobs.map((item) => {
      const child = item.child === null ? null : parseJobCleanupState(item.child);
      if (child !== null && (child.authority.action !== intent.request || child.authority.job !== item.artifact || child.authority.createdAt < raw.createdAt || child.authority.deadline > raw.deadline)) throw new Error("removal job evidence disagrees");
      return Object.freeze({ ...item, child });
    }));
    const services = Object.freeze(raw.services.map((item, i) => {
      const barrier = item.barrier === null ? null : parseManagedServiceBarrier(item.barrier);
      const plan = inventory.services[i];
      if (barrier !== null && (plan === undefined || barrier.action.action !== intent.action || barrier.action.service !== plan.name ||
        barrier.action.plan !== plan.digest || barrier.action.deadline !== raw.deadline || barrier.createdAt < raw.createdAt ||
        barrier.action.app !== intent.owner.app || barrier.action.incarnation !== intent.owner.incarnation ||
        barrier.action.dataOwner !== intent.owner.dataOwner || JSON.stringify(barrier.prior) !== JSON.stringify(plan.prior))) throw new Error("removal service evidence disagrees");
      return Object.freeze({ ...item, barrier });
    }));
    if (["stopping", "complete"].includes(raw.phase) && jobs.some((item) => item.child?.phase !== "complete") ||
      raw.phase === "complete" && services.some((item) => item.barrier?.phase !== "complete")) throw new Error("removal cessation evidence is incomplete");
    const identities = raw.checks.map((item) => item.container);
    const final = raw.finishedAt;
    if (final === null ? raw.checks.length !== 0 :
      new Set(identities).size !== identities.length ||
      raw.checks.length !== new Set(inventory.checks.map((item) => item.container)).size ||
      raw.checks.some((item) => {
        const target = inventory.checks.find((check) => check.container === item.container && check.action.service === item.service);
        const proof = services.find((service) => service.name === item.service)?.barrier?.proof;
        return target === undefined || target.service !== proof?.native.id ||
          item.version < proof.native.version || item.at < proof.at || item.at > final;
      })) throw new Error("removal check cessation evidence disagrees");
    return Object.freeze({ ...raw, jobs, services });
  };
  const load = async () => { const raw = await journal.read(); return raw === undefined ? undefined : parse(raw); };
  const required = async () => { const state = await load(); if (state === undefined) throw new Error("removal effects intent is missing"); return state; };
  type State = ReturnType<typeof parse>;
  const write = async (input: State) => {
    const state = parse(input);
    try { await journal.write(state); } catch { poisoned = true; throw new Error("removal journal write uncertain; reopen"); }
    return state;
  };
  const hold = (state: State, reason: NonNullable<State["reason"]>) => write({ ...state, phase: "held", reason, finishedAt: null });
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => {
    const left = Math.min(10_000, deadline - ports.now());
    if (left <= 0) return undefined;
    const expired = Promise.withResolvers<undefined>();
    const timer = setTimeout(() => { expired.resolve(undefined); }, left);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), expired.promise]); }
    finally { clearTimeout(timer); }
  };
  const authorized = (state: State, action: ManagedServiceAction | null) =>
    bounded(state.deadline, () => ports.authorize(intent, action)).then((allowed) => allowed === true && ports.now() < state.deadline);
  const fencesCurrent = async (state: State, deadline = state.deadline) => {
    for (const entry of state.jobs) {
      const child = entry.child;
      if (child?.phase !== "complete") return false;
      const bytes = await bounded(deadline, () => ports.read(entry.artifact));
      if (bytes === undefined) return false;
      const parsed = parseJobPlan(JSON.parse(bytes));
      if (!parsed.ok || jobPlanDigest(parsed.value) !== entry.artifact || bytes !== JSON.stringify(parsed.value)) return false;
      const value = await bounded(deadline, () => ports.jobs.observe(parsed.value));
      if (value?.status !== "owned" || !value.barrier || value.state !== "created" || value.id !== child.barrier || value.plan !== entry.artifact) return false;
    }
    return true;
  };
  const jobOwner = (artifact: string) => jobCleanup({
    read: async () => (await required()).jobs.find((item) => item.artifact === artifact)?.child ?? undefined,
    write: async (raw) => {
      const state = await required(); const child = parseJobCleanupState(raw);
      if (state.phase !== "fencing-jobs") throw new Error("removal job lost its owner");
      await write({ ...state, jobs: state.jobs.map((item) => item.artifact === artifact ? { ...item, child } : item) });
    },
  }, {
    ...ports,
    read: async (digest) => {
      const state = await required();
      const bytes = await bounded(state.deadline, () => ports.read(digest));
      if (bytes === undefined) throw new Error("removal job artifact unavailable");
      return bytes;
    },
    native: {
      observe: async (job) => await bounded((await required()).deadline, () => ports.jobs.observe(job)) ?? { status: "unavailable" },
      fence: async (job, authority, container) => {
        const state = await required();
        if (state.phase !== "fencing-jobs" || !await authorized(state, null)) return "refused";
        return await bounded(authority.deadline, () => ports.jobs.fence(job, authority, container)) ?? "uncertain";
      },
    },
    authorize: async () => authorized(await required(), null),
  });
  const barrierOwner = (name: string) => managedServiceBarrier({
    read: async () => (await required()).services.find((item) => item.name === name)?.barrier ?? undefined,
    write: async (raw) => {
      const state = await required(); const barrier = parseManagedServiceBarrier(raw);
      if (state.phase !== "stopping") throw new Error("removal service lost its owner");
      await write({ ...state, services: state.services.map((item) => item.name === name ? { ...item, barrier } : item) });
    },
  }, {
    ...ports, runtime: {
      observe: ports.services.observe,
      tombstone: async (...args) => {
        const state = await required();
        if (state.phase !== "stopping" || !await fencesCurrent(state) || !await authorized(state, args[0])) return "refused";
        return ports.services.tombstone(...args);
      },
    },
    authorize: async (_, action) => authorized(await required(), action),
  });
  const scope = (service: string) => Object.freeze({ app: intent.owner.app, incarnation: intent.owner.incarnation, dataOwner: intent.owner.dataOwner, service });

  const observeStopped = async (entry: State["services"][number], deadline: number, started = ports.now()) => {
    const barrier = entry.barrier;
    const proof = barrier?.proof;
    const step = barrier?.steps.at(-1);
    if (barrier == null || proof == null || step?.effect !== "scrub") return Object.freeze({ status: "service" as const });
    const action = Object.freeze({ ...barrier.action, effect: "scrub" as const, action: serviceEffectAction(intent.action, "scrub", step.attempt) });
    const native = await bounded(deadline, () => ports.services.observe(scope(entry.name)));
    if (native?.status !== "owned" || native.id !== proof.native.id || native.version < proof.native.version ||
      native.action !== action.action || native.effect !== "scrub" || native.plan !== barrier.action.plan || !clearedService(native)) return Object.freeze({ status: "service" as const });
    const observed = await Promise.all(inventory.checks.filter((item) => item.action.service === entry.name).map(async (target) => {
      const value = await bounded(deadline, () => ports.containers.observe({ target, barrier: action, native: proof.native }));
      if (value?.status === "pending" || value?.status === "unavailable" || value === undefined) return Object.freeze({ status: "pending" as const });
      if (value.status !== "fenced" || value.native.id !== proof.native.id || value.native.version < proof.native.version ||
        value.checkedAt < Math.max(proof.at, started) || value.checkedAt > ports.now()) return Object.freeze({ status: "check" as const });
      return Object.freeze({ status: "ready" as const, proof: Object.freeze({
        container: target.container, service: entry.name, version: value.native.version, at: value.checkedAt, kind: value.kind,
      }) });
    }));
    if (observed.some((item) => item.status === "check")) return Object.freeze({ status: "check" as const });
    if (observed.some((item) => item.status === "pending")) return Object.freeze({ status: "pending" as const });
    return Object.freeze({ status: "ready" as const, checks: Object.freeze(observed.flatMap((item) => Object.freeze(item.status === "ready" ? [item.proof] : []))) });
  };

  return Object.freeze({
    prepare: (createdAt: number) => serial(async () => {
      const existing = await load();
      if (existing !== undefined) return existing;
      const state = parse({
        version: 1, inventory: identity, createdAt, deadline: createdAt + 90_000, phase: "fencing-jobs", reason: null, finishedAt: null, checks: [],
        jobs: inventory.jobs.map((artifact) => Object.freeze({ artifact, child: null })),
        services: inventory.services.map(({ name }) => Object.freeze({ name, barrier: null })),
      });
      if (ports.now() < createdAt || ports.now() >= state.deadline) throw new Error("removal effects intent window expired");
      return write(state);
    }),
    read: () => serial(load),
    observeCompletion: () => serial(async () => {
      const state = await required();
      if (state.phase !== "complete") throw new Error("managed removal effects are incomplete");
      const started = ports.now();
      const deadline = started + 10_000;
      if (!await fencesCurrent(state, deadline)) throw new Error("managed removal job fence changed");
      const services = await Promise.all(state.services.map((entry) => observeStopped(entry, deadline)));
      const observedAt = ports.now();
      if (observedAt < started || observedAt >= deadline || services.some((item) => item.status !== "ready")) throw new Error("managed removal service or check fence changed");
      return Object.freeze({ inventory: state.inventory, effects: managedRemovalInventoryDigest(state), observedAt });
    }),
    tick: () => serial(async () => {
      const state = await required();
      if (state.phase === "complete" || state.phase === "held") return state;
      if (ports.now() >= state.deadline) return hold(state, "deadline");
      if (!await authorized(state, null)) return hold(state, "authority");
      if (state.phase === "fencing-jobs") {
        const entry = state.jobs.find((item) => item.child?.phase !== "complete");
        if (entry === undefined) return write({ ...state, phase: "stopping" });
        if (entry.child?.phase === "held") return hold(state, "job");
        const child = jobOwner(entry.artifact);
        if (entry.child === null) {
          const createdAt = ports.now();
          if (createdAt + 30_000 > state.deadline) return hold(state, "deadline");
          await child.prepare({ version: 1, action: intent.request, job: entry.artifact, createdAt, deadline: createdAt + 30_000 });
        } else await child.tick();
        return required();
      }
      if (!await fencesCurrent(state)) return hold(state, "job");
      // eslint-disable-next-line functional/prefer-immutable-types -- collected locally and frozen at journal validation
      const checks: z.infer<typeof checkProof>[] = [];
      for (const entry of state.services) {
        const plan = inventory.services.find((item) => item.name === entry.name);
        if (plan === undefined) throw new Error("removal service plan is missing");
        const child = barrierOwner(plan.name);
        if (entry.barrier?.phase === "held") return hold(state, "service");
        if (entry.barrier === null) {
          await child.prepare(plan.plan, { ...scope(plan.name), action: intent.action, plan: plan.digest, deadline: state.deadline, effect: "remove" }, plan.prior);
          return required();
        }
        if (entry.barrier.phase !== "complete") {
          await child.tick(); return required();
        }
        const observation = await observeStopped(entry, state.deadline);
        if (observation.status === "pending") return state;
        if (observation.status !== "ready") return hold(state, observation.status);
        for (const item of observation.checks) if (!checks.some((other) => other.container === item.container)) {
          // eslint-disable-next-line functional/immutable-data -- collect observations for one synchronized write
          checks.push(item);
        }

      }
      if (!await authorized(state, null) || !await fencesCurrent(state)) return hold(state, "authority");
      const at = ports.now();
      return at >= state.deadline ? hold(state, "deadline") : write({ ...state, phase: "complete", finishedAt: at, checks });
    }),
  });
};
