/* Disconnected prototype. No operation here authorizes or executes an effect.
 * The composition root must exclusively own this journal (including across
 * other journal consumers), bind its identity to a durable app index, and
 * authenticate registration references. Lost allocation replies can exhaust
 * reservations; this is not a live endpoint or a complete lifecycle owner. */
/* eslint-disable functional/prefer-immutable-types */
import { z } from "zod";
import type { OperationJournal } from "./operation.ts";
import { claimJournal } from "./journal-claim.ts";
import { parseLifecycleEnvelope } from "./lifecycle-envelope.ts";
import { beginRegistration, lifecycleActionId, settleLifecycleWork } from "./lifecycle-fence.ts";
import { admitTicket, completeTicket, initialTicketState, reserveTicket } from "./lifecycle-tickets.ts";

const evidence = z.object({ app: z.string(), incarnation: z.string(), actionId: z.string(), registrationGeneration: z.string(), status: z.enum(["applied", "not-applied", "unknown"]) }).strict();
type RegistrationObservation = { readonly app: string; readonly incarnation: string; readonly actionId: string; readonly registrationGeneration: string };
/** The composition root, never a client request, supplies this trusted read-only port. */
export type RegistrationObserver = (expected: RegistrationObservation) => Promise<unknown>;

export const openLifecycleEnvelopeStore = (journal: OperationJournal, observeRegistration?: RegistrationObserver) => {
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
    /** Allocation is durable before return, but a lost allocation reply is not recoverable here. */
    reserveRegistration: () => serial(async () => {
      const current = await required();
      if (current.created) throw new Error("initial registration is already in progress or complete");
      const reserved = reserveTicket(current.tickets);
      if (!reserved.ok) throw new Error(reserved.error);
      await persist({ ...current, tickets: reserved.value.state });
      return reserved.value.ticket;
    }),
    /** A new response acknowledges persisted intent only; reconcile responses never permit replay. */
    submitRegistration: (ticket: string, registrationGeneration: string) => {
      if (typeof ticket !== "string" || typeof registrationGeneration !== "string") return Promise.reject(new Error("invalid registration request"));
      const descriptor = Object.freeze({ kind: "register" as const, registrationGeneration });
      return serial(async () => {
        const current = await required();
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
    /** Only the injected trusted observer may establish an applied outcome. */
    reconcileRegistration: (ticket: string, registrationGeneration: string) => {
      if (typeof ticket !== "string" || typeof registrationGeneration !== "string") return Promise.reject(new Error("invalid registration request"));
      const descriptor = Object.freeze({ kind: "register" as const, registrationGeneration });
      return serial(async () => {
        const current = await required();
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
        const observation = await (async () => {
          try { return evidence.safeParse(await observeRegistration(expected)); }
          catch { return undefined; }
        })();
        if (observation === undefined || !observation.success || observation.data.status !== "applied" || observation.data.app !== expected.app || observation.data.incarnation !== expected.incarnation || observation.data.actionId !== expected.actionId || observation.data.registrationGeneration !== expected.registrationGeneration) return Object.freeze({ status: "pending" as const });
        const settled = settleLifecycleWork(fence, actionId);
        const completed = completeTicket(current.tickets, ticket, "success");
        if (!settled.ok || !completed.ok) throw new Error("invalid registration settlement");
        await persist({ ...current, fence: settled.value, tickets: completed.value, operations: current.operations.filter((item) => item.ticket !== ticket) });
        return Object.freeze({ status: "verified" as const });
      });
    },
  };
};
