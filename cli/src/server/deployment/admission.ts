import { err, ok } from "../../lib/result.ts";
import { typed } from "../../lib/typed.ts";

/** All CPU budgets use millicores and all memory budgets use bytes. */
export type Budget = { readonly cpu: number; readonly memory: number };
export type Reservation = { readonly id: string; readonly budget: Budget; readonly deadline: number };
export type AdmissionState = {
  readonly capacity: Budget;
  readonly platform: Budget;
  readonly workloads: readonly { readonly id: string; readonly budget: Budget }[];
  readonly reservations: readonly Reservation[];
};

const valid = (budget: Budget) => Number.isSafeInteger(budget.cpu) && budget.cpu > 0 && Number.isSafeInteger(budget.memory) && budget.memory > 0;
const identity = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);

/**
 * Decide against a caller-supplied, serialized snapshot. A lease remains charged
 * after its deadline until its owner has reconciled and settled the workload.
 */
export const reserve = (state: AdmissionState, requested: Reservation, now: number) => {
  if (!valid(state.capacity) || !valid(state.platform) || !Number.isSafeInteger(now) || now < 0) return err("invalid host budget or time");
  if (!identity(requested.id) || !valid(requested.budget) || !Number.isSafeInteger(requested.deadline) || requested.deadline <= now) return err("invalid reservation or expired deadline");
  const workloads = state.workloads;
  const reservations = state.reservations;
  if (workloads.some((item) => !identity(item.id) || !valid(item.budget)) || reservations.some((item) => !identity(item.id) || !valid(item.budget) || !Number.isSafeInteger(item.deadline) || item.deadline <= 0)) return err("invalid admitted workload or reservation");
  if (new Set(workloads.map((item) => item.id)).size !== workloads.length || new Set(reservations.map((item) => item.id)).size !== reservations.length) return err("duplicate workload or reservation identity");
  const existing = reservations.find((item) => item.id === requested.id);
  if (existing !== undefined && (existing.deadline !== requested.deadline || existing.budget.cpu !== requested.budget.cpu || existing.budget.memory !== requested.budget.memory)) return err("reservation identity already has different intent");
  const charged = [...workloads.map((item) => item.budget), ...reservations.map((item) => item.budget), ...(existing === undefined ? [requested.budget] : [])];
  const total = charged.reduce<Budget>((sum, item) => typed<Budget>({ cpu: sum.cpu + item.cpu, memory: sum.memory + item.memory }), state.platform);
  if (!Number.isSafeInteger(total.cpu) || !Number.isSafeInteger(total.memory) || total.cpu > state.capacity.cpu || total.memory > state.capacity.memory) return err("insufficient declared host capacity");
  const snapshotBudget = (budget: Budget) => Object.freeze({ cpu: budget.cpu, memory: budget.memory });
  const snapshotReservation = (reservation: Reservation) => Object.freeze({ id: reservation.id, budget: snapshotBudget(reservation.budget), deadline: reservation.deadline });
  return ok<AdmissionState>(Object.freeze({
    capacity: snapshotBudget(state.capacity),
    platform: snapshotBudget(state.platform),
    workloads: Object.freeze(workloads.map((workload) => Object.freeze({ id: workload.id, budget: snapshotBudget(workload.budget) }))),
    reservations: Object.freeze((existing === undefined ? [...reservations, requested] : reservations).map(snapshotReservation)),
  }));
};
