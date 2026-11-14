/* The controller serializes one private journal and poisons uncertain writes. */
/* eslint-disable functional/no-let */
import { z } from "zod";
import { parseDataOwnership, volumeActionSchema } from "../../contracts/owned-volume.ts";
import type { OwnedVolumePort, VolumeReceipt } from "../../contracts/owned-volume.ts";
import type { OperationJournal } from "./operation.ts";
import { typed } from "../../lib/typed.ts";
import { claimJournal } from "./journal-claim.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({ version: z.literal(1), owner: z.unknown(), deployment: z.string().regex(/^[a-f0-9]{64}$/), action: volumeActionSchema,
  createdAt: positive, phase: z.enum(["prepared", "creating", "ready", "held"]), attempts: z.number().int().min(0).max(8),
  receipt: z.string().max(128).refine((value) => Number.isFinite(Date.parse(value))).nullable(),
  reason: z.enum(["deadline", "unauthorized", "conflict", "missing", "attempts"]).nullable(),
}).strict().readonly();
export const parseDataVolumeCreation = (input: unknown) => {
  const checked = schema.safeParse(input); if (!checked.success) throw new Error("invalid volume creation state");
  const state = checked.data; const owner = parseDataOwnership(state.owner);
  if (!owner.ok || owner.value.app !== state.action.volume.app || owner.value.dataOwner !== state.action.volume.dataOwner ||
    state.action.deadline <= state.createdAt || state.action.deadline - state.createdAt > 90000 ||
    (state.phase === "held") !== (state.reason !== null) || (state.phase === "prepared" && (state.attempts !== 0 || state.receipt !== null)) ||
    (state.phase === "creating" && (state.attempts === 0 || state.receipt !== null)) || (state.phase === "ready" && (state.attempts === 0 || state.receipt === null)) ||
    ((state.reason === "missing") && state.receipt === null) || (state.reason === "attempts" && state.attempts !== 8)) throw new Error("inconsistent volume creation state");
  return Object.freeze({ ...state, owner: owner.value });
};
export type DataVolumeCreation = ReturnType<typeof parseDataVolumeCreation>;
type Ports = {
  readonly native: Pick<OwnedVolumePort, "observe" | "create">;
  /** The owning coordinator verifies its registration fence, allocation, plan and current resource lease. */
  readonly authorize: (state: DataVolumeCreation) => Promise<boolean>;
  readonly now: () => number;
};
type Observation = Awaited<ReturnType<OwnedVolumePort["observe"]>>;
const sameVolume = (receipt: VolumeReceipt, state: DataVolumeCreation) => JSON.stringify(receipt.volume) === JSON.stringify(state.action.volume);

/** Creation is idempotent only within this never-reused allocation. This controller never deletes volumes or starts workloads. */
export const dataVolumeCreation = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "volume creation journal already has an owner");
  let pending = Promise.resolve(); let poisoned = false;
  const serial = <T>(use: () => Promise<T>) => {
    const result = pending.then(() => { if (poisoned) throw new Error("volume creation write is uncertain; reopen and reconcile"); return use(); });
    pending = result.then(() => undefined, () => undefined); return result;
  };
  const load = async () => { const raw = await journal.read(); return raw === undefined ? undefined : parseDataVolumeCreation(raw); };
  const write = async (input: DataVolumeCreation) => {
    const state = parseDataVolumeCreation(input);
    try { await journal.write(state); } catch { poisoned = true; throw new Error("volume creation write is uncertain; reopen and reconcile"); }
    return state;
  };
  const time = (minimum: number) => { const now = ports.now(); if (!Number.isSafeInteger(now) || now < minimum) throw new Error("volume creation clock is unavailable"); return now; };
  const boundedAt = async <T>(deadline: number, minimum: number, call: () => Promise<T>) => {
    const remaining = Math.min(10000, deadline - time(minimum));
    if (remaining <= 0) return { status: "timeout" } as const;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = Promise.resolve().then(call).then((value) => ({ status: "completed", value }) as const, () => ({ status: "unavailable" }) as const);
    try { return await Promise.race([result, new Promise<{ readonly status: "timeout" }>((resolve) => { timer = setTimeout(() => { resolve({ status: "timeout" }); }, remaining); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const bounded = <T>(state: DataVolumeCreation, call: () => Promise<T>) => boundedAt(state.action.deadline, state.createdAt, call);
  const hold = (state: DataVolumeCreation, reason: NonNullable<DataVolumeCreation["reason"]>) => write({ ...state, phase: "held", reason });
  const result = (state: DataVolumeCreation, observation: Observation["status"]) => Object.freeze({ state, observation });
  return Object.freeze({
    prepare: (input: Pick<DataVolumeCreation, "owner" | "deployment" | "action" | "createdAt">) => {
      const proposal = parseDataVolumeCreation({ version: 1, ...input, phase: "prepared", attempts: 0, receipt: null, reason: null });
      return serial(async () => {
        const existing = await load();
        if (existing !== undefined) {
          if (JSON.stringify(existing.owner) !== JSON.stringify(proposal.owner) || existing.deployment !== proposal.deployment || existing.createdAt !== proposal.createdAt || JSON.stringify(existing.action) !== JSON.stringify(proposal.action)) throw new Error("volume creation intent conflicts");
          return existing;
        }
        time(proposal.createdAt); return write(proposal);
      });
    },
    tick: () => serial(async () => {
      const state = await load(); if (state === undefined) throw new Error("volume creation intent is missing");
      if (state.phase === "held") return result(state, "unavailable");
      if (time(state.createdAt) >= state.action.deadline) return result(state.phase === "ready" ? state : await hold(state, "deadline"), "unavailable");
      const observed = await bounded(state, () => ports.native.observe(state.action.volume));
      if (observed.status !== "completed") return result(time(state.createdAt) >= state.action.deadline && state.phase !== "ready" ? await hold(state, "deadline") : state, "unavailable");
      const volume = observed.value;
      if (volume.status === "unavailable") return result(state, volume.status);
      if (volume.status === "foreign") return result(await hold(state, "conflict"), volume.status);
      if (state.receipt !== null) {
        if (volume.status === "owned") {
          if (!sameVolume(volume.receipt, state) || volume.receipt.createdAt !== state.receipt) return result(await hold(state, "conflict"), "foreign");
          return result(state, "owned");
        }
        return result(await hold(state, "missing"), "absent");
      }
      if (volume.status === "owned") {
        if (state.phase !== "creating" || !sameVolume(volume.receipt, state)) return result(await hold(state, "conflict"), "foreign");
        return result(await write({ ...state, phase: "ready", receipt: volume.receipt.createdAt }), "owned");
      }
      if (time(state.createdAt) >= state.action.deadline) return result(await hold(state, "deadline"), "absent");
      if (state.attempts === 8) return result(await hold(state, "attempts"), "absent");
      const intent = await write({ ...state, phase: "creating", attempts: state.attempts + 1 });
      const authority = await bounded(intent, () => ports.authorize(intent));
      if (authority.status !== "completed") return result(time(intent.createdAt) >= intent.action.deadline ? await hold(intent, "deadline") : intent, "unavailable");
      if (!authority.value) return result(await hold(intent, "unauthorized"), "absent");
      if (time(intent.createdAt) >= intent.action.deadline) return result(await hold(intent, "deadline"), "absent");
      const effect = await bounded(intent, () => ports.native.create(intent.action));
      if (effect.status === "completed" && effect.value !== "acknowledged" && effect.value !== "uncertain") return result(await hold(intent, "conflict"), "unavailable");
      return result(intent, "unavailable");
    }),
    inspect: (observationDeadline: number) => serial(async () => {
      const state = await load(); if (state === undefined) throw new Error("volume creation intent is missing");
      const now = time(state.createdAt);
      if (!Number.isSafeInteger(observationDeadline) || observationDeadline <= now || observationDeadline - now > 10000) throw new Error("invalid volume observation deadline");
      const observed = await boundedAt(observationDeadline, state.createdAt, () => ports.native.observe(state.action.volume));
      if (observed.status !== "completed" || time(state.createdAt) >= observationDeadline) return typed<Observation>({ status: "unavailable" });
      const volume = observed.value;
      if (volume.status !== "owned") return volume;
      return state.attempts > 0 && sameVolume(volume.receipt, state) && (state.receipt === null || state.receipt === volume.receipt.createdAt)
        ? volume : typed<Observation>({ status: "foreign" });
    }),
    read: () => serial(load),
  });
};
