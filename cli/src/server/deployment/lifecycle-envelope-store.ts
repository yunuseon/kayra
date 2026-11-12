/* Disconnected prototype. No operation here authorizes or executes an effect.
 * The composition root must exclusively own this journal (including across
 * other journal consumers), bind its identity to a durable app index, and
 * authenticate registration references. This is not a live endpoint or a
 * complete lifecycle owner. */
/* eslint-disable functional/prefer-immutable-types */
import type { Runtime } from "../../contracts/rollout.ts";
import type { OperationJournal } from "./operation.ts";
import { parseRegistrationObservation } from "../../contracts/registration-generation.ts";
import { claimJournal } from "./journal-claim.ts";
import { parseLifecycleEnvelope, registrationGenerationId } from "./lifecycle-envelope.ts";
import { z } from "zod";
import { parseHttpNativeStep } from "./http-state.ts";
import type { HttpNativeStep } from "./http-state.ts";
import { beginLifecycleWork, beginRegistration, lifecycleActionId, settleLifecycleWork } from "./lifecycle-fence.ts";
import { admitTicket, completeTicket, initialTicketState, reserveTicket } from "./lifecycle-tickets.ts";

type RegistrationObservation = { readonly app: string; readonly incarnation: string; readonly actionId: string; readonly registrationGeneration: string };
/** The composition root, never a client request, supplies this trusted read-only port. */
export type RegistrationObserver = (expected: RegistrationObservation, signal: AbortSignal) => Promise<unknown>;

const observeWithDeadline = async (observe: RegistrationObserver, expected: RegistrationObservation, timeoutMs: number) => {
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const timeout = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => {
    timeout.resolve(undefined);
    controller.abort();
  }, timeoutMs);
  try {
    const evidence = await Promise.race([observe(expected, controller.signal), timeout.promise]);
    if (performance.now() >= deadline) {
      controller.abort();
      return undefined;
    }
    return parseRegistrationObservation(evidence);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

export const openLifecycleEnvelopeStore = (journal: OperationJournal, observeRegistration?: RegistrationObserver, observationTimeoutMs = 10_000) => {
  if (!Number.isInteger(observationTimeoutMs) || observationTimeoutMs < 1 || observationTimeoutMs > 2_147_483_647) throw new Error("invalid registration observation timeout");
  claimJournal(journal, "lifecycle envelope journal is already owned");
  // eslint-disable-next-line functional/no-let -- serialize the exclusive writer
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- a failed write may nevertheless have committed
  let poisoned = false;
  const serial = <T>(task: () => Promise<T>) => {
    const result = pending.then(() => {
      if (poisoned) throw new Error("lifecycle write outcome is uncertain; reopen and reconcile");
      return task();
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  const load = async () => {
    const raw = await journal.read();
    if (raw === undefined) return undefined;
    const parsed = parseLifecycleEnvelope(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };
  const persist = async (candidate: unknown) => {
    const checked = parseLifecycleEnvelope(candidate);
    if (!checked.ok) throw new Error(checked.error);
    try {
      await journal.write(checked.value);
      return checked.value;
    } catch (error) {
      poisoned = true;
      throw error;
    }
  };
  const required = async () => {
    const value = await load();
    if (value === undefined) throw new Error("lifecycle envelope is not initialized");
    return value;
  };
  return {
    read: () => serial(load),
    /** The caller must establish that this is a new, durably indexed incarnation. */
    initialize: (app: string, incarnation: string) => serial(async () => {
      const existing = await load();
      if (existing !== undefined) {
        if (!existing.created && existing.tickets.app === app && existing.tickets.incarnation === incarnation) return existing;
        throw new Error("lifecycle envelope is already initialized");
      }
      const tickets = initialTicketState(app, incarnation);
      if (!tickets.ok) throw new Error(tickets.error);
      return persist({ version: 1, created: false, fence: null, tickets: tickets.value, operations: [] });
    }),
    /** The caller durably retains the generation ID before requesting a ticket. */
    reserveRegistration: (generation?: string, runtime: Runtime = "compose") => serial(async () => {
      if (runtime === "swarm" && generation === undefined) throw new Error("Swarm requires an indexed registration generation");
      if (generation !== undefined && !registrationGenerationId.safeParse(generation).success) throw new Error("invalid registration generation");
      const current = await required();
      const allocation = current.registrationAllocation;
      if (allocation !== undefined) {
        if (allocation.generation !== generation || allocation.runtime !== runtime) throw new Error("initial registration allocation conflict");
        return allocation.ticket;
      }
      if (current.created) throw new Error("initial registration is already in progress or complete");
      if (generation !== undefined && current.tickets.active.length !== 0) throw new Error("initial registration has outstanding legacy reservations");
      const reserved = reserveTicket(current.tickets);
      if (!reserved.ok) throw new Error(reserved.error);
      await persist({
        ...current, tickets: reserved.value.state,
        ...(generation === undefined ? {} : { registrationAllocation: { generation, ticket: reserved.value.ticket, runtime } }),
      });
      return reserved.value.ticket;
    }),
    /** A new response acknowledges persisted intent only; reconcile responses never permit replay. */
    submitRegistration: (ticket: string, registrationGeneration: string) => {
      if (typeof ticket !== "string" || typeof registrationGeneration !== "string") return Promise.reject(new Error("invalid registration request"));
      const descriptor = Object.freeze({ kind: "register" as const, registrationGeneration });
      return serial(async () => {
        const current = await required();
        const allocation = current.registrationAllocation;
        if (allocation !== undefined && (allocation.ticket !== ticket || allocation.generation !== registrationGeneration)) {
          throw new Error("initial registration allocation conflict");
        }
        if (current.registrationReceipt?.ticket === ticket && current.registrationReceipt.metadata.registrationGeneration === registrationGeneration) return Object.freeze({ status: "terminal" as const, outcome: "success" as const });
        const admitted = admitTicket(current.tickets, ticket, descriptor);
        if (!admitted.ok) throw new Error(admitted.error);
        if (admitted.value.status === "terminal") return Object.freeze({ status: "terminal" as const, outcome: admitted.value.outcome });
        if (admitted.value.status === "accepted") {
          const fence = current.fence;
          if (fence?.lifecycle.phase !== "registering" || fence.lifecycle.active.sequence !== 1) throw new Error("ticket is not an initial registration intent");
          const existing = current.operations.find((operation) => operation.ticket === ticket);
          if (existing?.action !== lifecycleActionId(fence, 1)) throw new Error("accepted ticket lacks initial registration intent");
          return Object.freeze({ status: "reconcile" as const, actionId: existing.action });
        }
        if (current.created) throw new Error("initial registration is already in progress or complete");
        const fence = beginRegistration(current.tickets.app, current.tickets.incarnation);
        if (!fence.ok) throw new Error(fence.error);
        const actionId = lifecycleActionId(fence.value, 1);
        await persist({ ...current, created: true, fence: fence.value, tickets: admitted.value.state, operations: [{ ticket, action: actionId, descriptor }] });
        return Object.freeze({ status: "new" as const, actionId });
      });
    },
    /** Internal lifecycle owner only. A prepared request cannot dispatch effects. */
    prepareHttp: (input: { readonly request: string; readonly plan: string; readonly commit: string; readonly service: string }, now: number) => {
      const parsed = z.object({ request: z.uuid(), plan: z.string().regex(/^[0-9a-f]{64}$/), commit: z.string().regex(/^[0-9a-f]{40}$/), service: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/) }).strict().safeParse(input);
      if (!parsed.success || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 90_000)) return Promise.reject(new Error("invalid HTTP request or clock"));
      const requested = Object.freeze(parsed.data);
      return serial(async () => {
        const current = await required();
        if (current.registrationReceipt?.runtime !== "swarm" || current.fence?.lifecycle.phase !== "registered") throw new Error("verified Swarm registration required");
        const existing = current.http?.requests.find((item) => item.request === requested.request);
        if (existing !== undefined) {
          if (existing.plan !== requested.plan || existing.commit !== requested.commit || existing.service !== requested.service) throw new Error("HTTP request identity has conflicting intent");
          return existing;
        }
        if ((current.http?.requests.length ?? 0) >= 1024) throw new Error("HTTP request history exhausted; intervention required");
        const fence = beginLifecycleWork(current.fence, "deploy");
        const reserved = reserveTicket(current.tickets);
        if (!fence.ok || !reserved.ok) throw new Error("HTTP lifecycle is busy or exhausted");
        const descriptor = Object.freeze({ kind: "deploy" as const, planDigest: requested.plan });
        const admitted = admitTicket(reserved.value.state, reserved.value.ticket, descriptor);
        if (!admitted.ok || admitted.value.status !== "new") throw new Error("invalid HTTP ticket allocation");
        const action = lifecycleActionId(fence.value, fence.value.nextAction - 1);
        const operation = { ...requested, ticket: reserved.value.ticket, action, deadline: now + 90_000,
          previous: current.http?.active ?? null, recoveryDeadline: null, phase: "prepared", reason: null, steps: [], verified: null };
        const next = await persist({ ...current, fence: fence.value, tickets: admitted.value.state,
          operations: [...current.operations, { ticket: reserved.value.ticket, action, descriptor }],
          http: { version: 1, app: current.tickets.app, incarnation: current.tickets.incarnation,
            requested: requested.plan, desired: requested.plan, active: current.http?.active ?? null, lastKnownGood: current.http?.lastKnownGood ?? null,
            requests: [...(current.http?.requests ?? []), operation] },
        });
        const saved = next.http?.requests.find((item) => item.request === requested.request);
        if (saved === undefined) throw new Error("HTTP intent was not retained");
        return saved;
      });
    },
    /** Call only after matching host-wide admission is durable. */
    admitHttp: (ticket: string) => serial(async () => {
      const current = await required();
      const request = current.http?.requests.find((item) => item.ticket === ticket);
      if (request === undefined || current.http === undefined || current.fence?.lifecycle.phase !== "registered" || current.fence.lifecycle.active === null || lifecycleActionId(current.fence, current.fence.lifecycle.active.sequence) !== request.action) throw new Error("HTTP action no longer owns lifecycle");
      if (request.phase === "admitted") return request;
      if (request.phase !== "prepared") throw new Error("HTTP action cannot be admitted in this phase");
      const next = await persist({ ...current, http: { ...current.http, requests: current.http.requests.map((item) => item === request ? { ...request, phase: "admitted" } : item) } });
      return next.http?.requests.find((item) => item.ticket === ticket);
    }),
    /** Persist exact native CAS authority before dispatch; replay must observe first. */
    recordHttpStep: (ticket: string, input: HttpNativeStep) => {
      const parsed = parseHttpNativeStep(input);
      if (!parsed.ok) return Promise.reject(new Error(parsed.error));
      const step = parsed.value;
      return serial(async () => {
        const current = await required();
        const request = current.http?.requests.find((item) => item.ticket === ticket);
        if (request === undefined || current.http === undefined || current.fence?.lifecycle.phase !== "registered" || current.fence.lifecycle.active === null || lifecycleActionId(current.fence, current.fence.lifecycle.active.sequence) !== request.action) throw new Error("HTTP action no longer owns lifecycle");
        const existing = request.steps.find((item) => item.effect === step.effect);
        if (existing !== undefined) {
          if (JSON.stringify(existing) !== JSON.stringify(step)) throw new Error("native HTTP intent conflicts; versions cannot be refreshed");
          return Object.freeze({ status: "reconcile" as const, request });
        }
        if (request.phase !== "admitted" || step.effect !== "apply" || step.plan !== request.plan || step.deadline !== request.deadline) throw new Error("native HTTP intent is outside admitted phase");
        const next = await persist({ ...current, http: { ...current.http, requests: current.http.requests.map((item) => item === request ? { ...request, phase: "applying", steps: [...request.steps, step] } : item) } });
        return Object.freeze({ status: "new" as const, request: next.http?.requests.find((item) => item.ticket === ticket) });
      });
    },
    /** Only the injected trusted observer may establish an applied outcome. */
    reconcileRegistration: (ticket: string, registrationGeneration: string) => {
      if (typeof ticket !== "string" || typeof registrationGeneration !== "string") return Promise.reject(new Error("invalid registration request"));
      const descriptor = Object.freeze({ kind: "register" as const, registrationGeneration });
      return serial(async () => {
        const current = await required();
        if (current.registrationReceipt?.ticket === ticket && current.registrationReceipt.metadata.registrationGeneration === registrationGeneration) return Object.freeze({ status: "terminal" as const, outcome: "success" as const });
        const admitted = admitTicket(current.tickets, ticket, descriptor);
        if (!admitted.ok) throw new Error(admitted.error);
        if (admitted.value.status === "terminal") return Object.freeze({ status: "terminal" as const, outcome: admitted.value.outcome });
        if (admitted.value.status !== "accepted") throw new Error("ticket has no accepted initial registration");
        const fence = current.fence;
        if (fence?.lifecycle.phase !== "registering" || fence.lifecycle.active.sequence !== 1) throw new Error("ticket is not an initial registration intent");
        const operation = current.operations.find((item) => item.ticket === ticket);
        const actionId = lifecycleActionId(fence, 1);
        if (operation?.action !== actionId) throw new Error("accepted ticket lacks initial registration intent");
        if (observeRegistration === undefined) return Object.freeze({ status: "pending" as const });
        const expected = Object.freeze({ app: fence.app, incarnation: fence.generation, actionId, registrationGeneration });
        const observation = await observeWithDeadline(observeRegistration, expected, observationTimeoutMs);
        if (observation === undefined || !observation.ok || observation.value.status !== "applied" || observation.value.app !== expected.app || observation.value.incarnation !== expected.incarnation || observation.value.actionId !== expected.actionId || observation.value.registrationGeneration !== expected.registrationGeneration) return Object.freeze({ status: "pending" as const });
        const settled = settleLifecycleWork(fence, actionId);
        const completed = completeTicket(current.tickets, ticket, "success");
        if (!settled.ok || !completed.ok) throw new Error("invalid registration settlement");
        await persist({ ...current, fence: settled.value, tickets: completed.value, operations: current.operations.filter((item) => item.ticket !== ticket),
          ...(current.registrationAllocation === undefined ? {} : { registrationReceipt: {
            ticket, runtime: current.registrationAllocation.runtime, metadata: { version: 1, ...expected },
          } }),
        });
        return Object.freeze({ status: "verified" as const });
      });
    },
  };
};
