import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { reserve, type AdmissionState } from "../../src/server/deployment/admission.ts";

const state: AdmissionState = {
  capacity: { cpu: 2000, memory: 4000 },
  platform: { cpu: 200, memory: 500 },
  workloads: [{ id: "active", budget: { cpu: 700, memory: 1500 } }],
  reservations: [],
};
const candidate = { id: "run-1", budget: { cpu: 700, memory: 1500 }, deadline: 1000 };

test("admission accounts for platform, active workloads and candidate overlap", () => {
  const admitted = reserve(state, candidate, 1);
  strictEqual(admitted.ok, true);
  strictEqual(reserve(admitted.value, { id: "job", budget: { cpu: 200, memory: 600 }, deadline: 1000 }, 2).ok, false);
  strictEqual(reserve(admitted.value, { id: "job", budget: { cpu: 400, memory: 500 }, deadline: 1000 }, 2).ok, true);
});

test("reservation retries are idempotent and deadlines cannot be extended", () => {
  const admitted = reserve(state, candidate, 1);
  if (!admitted.ok) throw new Error(admitted.error);
  strictEqual(reserve(admitted.value, candidate, 2).ok, true);
  strictEqual(reserve(admitted.value, { ...candidate, deadline: 2000 }, 2).ok, false);
  strictEqual(reserve(admitted.value, candidate, 1000).ok, false);
});

test("expired unsettled reservations remain charged, and malformed accounting is refused", () => {
  const held: AdmissionState = { ...state, reservations: [candidate] };
  strictEqual(reserve(held, { id: "next", budget: { cpu: 1, memory: 501 }, deadline: 2000 }, 1500).ok, false);
  strictEqual(reserve({ ...state, platform: { cpu: 0, memory: 1 } }, candidate, 1).ok, false);
  strictEqual(reserve({ ...state, workloads: [...state.workloads, { id: "active", budget: { cpu: 700, memory: 1500 } }] }, candidate, 1).ok, false);
  strictEqual(reserve({ ...state, capacity: { cpu: Number.MAX_SAFE_INTEGER, memory: Number.MAX_SAFE_INTEGER }, platform: { cpu: Number.MAX_SAFE_INTEGER, memory: 1 } }, candidate, 1).ok, false);
});

test("admission snapshots input budgets and reservation identities", () => {
  const input = {
    capacity: { cpu: 2000, memory: 4000 },
    platform: { cpu: 200, memory: 500 },
    workloads: [{ id: "active", budget: { cpu: 700, memory: 1500 } }],
    reservations: [{ id: "old", budget: { cpu: 100, memory: 100 }, deadline: 1000 }],
  };
  const request = { id: "new", budget: { cpu: 700, memory: 1500 }, deadline: 1000 };
  const admitted = reserve(input, request, 1);
  if (!admitted.ok) throw new Error(admitted.error);
  // eslint-disable-next-line functional/immutable-data -- simulate a mutable caller retaining each input
  input.capacity.memory = 9000;
  // eslint-disable-next-line functional/immutable-data -- simulate a mutable caller retaining each input
  input.platform.memory = 1;
  const workload = input.workloads[0];
  if (workload === undefined) throw new Error("missing fixture workload");
  // eslint-disable-next-line functional/immutable-data -- simulate a mutable caller retaining each input
  workload.budget.memory = 1;
  const reservation = input.reservations[0];
  if (reservation === undefined) throw new Error("missing fixture reservation");
  // eslint-disable-next-line functional/immutable-data -- simulate a mutable caller retaining each input
  reservation.budget.memory = 1;
  // eslint-disable-next-line functional/immutable-data -- simulate a mutable caller retaining each input
  request.budget.memory = 1;
  strictEqual(admitted.value.capacity.memory, 4000);
  strictEqual(admitted.value.platform.memory, 500);
  strictEqual(admitted.value.workloads[0]?.budget.memory, 1500);
  strictEqual(admitted.value.reservations[0]?.budget.memory, 100);
  strictEqual(admitted.value.reservations[1]?.budget.memory, 1500);
  strictEqual(reserve(admitted.value, { id: "extra", budget: { cpu: 1, memory: 401 }, deadline: 1000 }, 2).ok, false);
});
