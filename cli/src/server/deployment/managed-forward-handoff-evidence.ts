import type { ManagedForwardCleanupRuntimePort } from "../../contracts/managed-forward-cleanup-context.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import { serviceEffectAction } from "../../contracts/swarm-service.ts";
import type { ManagedForwardEffectSource } from "./managed-forward-effect-source.ts";
import type { ManagedForwardEffects } from "./managed-forward-effect-state.ts";
import { managedForwardEffectNodes, managedForwardEffectSourceDigest } from "./managed-forward-effect-source.ts";
import { verifyManagedRecoveryJobs } from "./managed-recovery-safety.ts";
import { clearedService, convergedService } from "./service-convergence.ts";

type Ports = Pick<ManagedForwardCleanupRuntimePort, "services" | "jobs" | "containers"> & {
  readonly retained: ManagedWorkloadPort["observeDesired"];
  readonly read: (digest: string) => Promise<string>;
  readonly now: () => number;
};

/** Fresh reads under the handoff window. This does not transfer capacity or grant any effects. */
export const observeManagedForwardHandoff = async (source: ManagedForwardEffectSource, cleanup: ManagedForwardEffects, deadline: number, ports: Ports) => {
  const started = ports.now();
  if (!Number.isSafeInteger(started) || !Number.isSafeInteger(deadline) || deadline <= started || deadline - started > 90_000 ||
    cleanup.phase !== "complete" || cleanup.finishedAt === null || cleanup.finishedAt > started ||
    cleanup.source !== managedForwardEffectSourceDigest(source) || cleanup.action !== source.request.action || cleanup.run !== source.request.run ||
    cleanup.createdAt !== source.request.createdAt || cleanup.deadline !== source.deadline) throw new Error("forward handoff lacks completed cleanup");

  const bounded = async <T>(call: () => Promise<T>) => {
    const left = Math.min(10_000, deadline - ports.now());
    if (left <= 0) throw new Error("forward handoff observation expired");
    const expired = Promise.withResolvers<never>();
    const timer = setTimeout(() => { expired.reject(new Error("forward handoff observation unavailable")); }, left);
    try {
      const value = await Promise.race([Promise.resolve().then(call), expired.promise]);
      if (ports.now() >= deadline) throw new Error("forward handoff observation expired");
      return value;
    } finally { clearTimeout(timer); }
  };

  const expected = managedForwardEffectNodes(source).map(({ name, plan, prior, waitFor, checks }) => Object.freeze({ name, plan, prior, waitFor, checks }));
  const present = cleanup.nodes.map(({ name, plan, prior, waitFor, checks }) => Object.freeze({ name, plan, prior, waitFor, checks }));
  if (JSON.stringify(expected) !== JSON.stringify(present)) throw new Error("forward handoff cleanup coverage changed");

  const blocked = source.baseline;
  const preparation = blocked.state.operation.preparation;
  if (preparation !== null) await bounded(() => verifyManagedRecoveryJobs(blocked.source, preparation, { read: ports.read, native: ports.jobs }));
  await Promise.all(cleanup.nodes.map(async (node) => {
    const barrier = node.barrier;
    const proof = barrier?.proof;
    const step = barrier?.steps.at(-1);
    if (barrier == null || proof == null || step?.effect !== "scrub") throw new Error("forward handoff consumer proof unavailable");
    const action = Object.freeze({ ...barrier.action, effect: "scrub" as const, action: serviceEffectAction(barrier.action.action, "scrub", step.attempt) });
    const observed = await bounded(() => ports.services.observe({ app: cleanup.app, incarnation: cleanup.incarnation, dataOwner: cleanup.dataOwner, service: node.name }));
    if (observed.status !== "owned" || !clearedService(observed) || observed.id !== proof.native.id || observed.version < proof.native.version ||
      observed.action !== action.action || observed.plan !== action.plan || observed.effect !== action.effect) throw new Error("forward handoff consumer fence changed");

    await Promise.all(node.checks.map(async (check) => {
      const current = await bounded(() => ports.containers.observe({ target: check.target, barrier: action, native: proof.native }));
      if (current.status !== "fenced" || current.native.id !== proof.native.id || current.native.version < proof.native.version ||
        current.checkedAt < started || current.checkedAt > ports.now()) throw new Error("forward handoff check container fence changed");
    }));
  }));

  const retained = Object.values(blocked.source.candidate.services).filter((service) => service.role === "retained-dependency");
  const dependencies = await Promise.all(retained.map(async (service) => {
    const prepared = preparation?.nodes.find((node) => node.name === service.service)?.ready;
    const previous = blocked.source.retained.find((item) => item.name === service.service && item.kind === "active");
    const reference = prepared ?? previous;
    if (reference?.action.plan !== managedServiceDigest(service)) throw new Error("forward handoff retained readiness identity unavailable");
    const observed = await bounded(() => ports.retained(reference.action, service, blocked.source.candidate));
    if (observed.status !== "owned" || observed.id !== reference.native.id || observed.version < reference.native.version ||
      !convergedService(reference.action, observed)) throw new Error("forward handoff retained dependency is not ready");
    return Object.freeze({ name: service.service, action: reference.action, native: Object.freeze({ id: observed.id, version: observed.version }) });
  }));
  const observedAt = ports.now();
  if (!Number.isSafeInteger(observedAt) || observedAt < started || observedAt >= deadline) throw new Error("forward handoff observation expired");
  return Object.freeze({ observedAt, retained: Object.freeze(dependencies) });
};
