/* eslint-disable functional/no-let -- serializes and poisons the single catalog writer */
import type { DataOwnership, OwnedVolume, VolumeReceipt } from "../../contracts/owned-volume.ts";
import { ownedVolumeSchema, parseDataOwnership } from "../../contracts/owned-volume.ts";
import type { RecordedVolumeReceiptsPort } from "../../contracts/recorded-volume-receipts.ts";
import { dataVolumeCreation, parseDataVolumeCreation } from "./data-volume-creation.ts";
import type { DataVolumeCreation } from "./data-volume-creation.ts";
import { parseVolumeCreationCatalog, recordedCatalogBirth } from "./volume-creation-catalog-state.ts";
import type { VolumeCreationCatalog } from "./volume-creation-catalog-state.ts";
import type { OperationJournal } from "./operation.ts";
import { volumeCatalogReceipts } from "./volume-catalog-receipts.ts";
import { claimJournal } from "./journal-claim.ts";
import { typed } from "../../lib/typed.ts";
import { z } from "zod";

type Proposal = Pick<DataVolumeCreation, "deployment" | "action" | "createdAt">;
type Ports = Omit<Parameters<typeof dataVolumeCreation>[1], "authorizeReceipt"> & {
  readonly authorizeReceipt: (state: DataVolumeCreation) => Promise<boolean>;
  readonly allowRegistration: (owner: DataOwnership, volumes: readonly OwnedVolume[]) => Promise<boolean>;
};
type Outcome = { readonly status: "recorded"; readonly receipt: VolumeReceipt } | { readonly status: "pending"; readonly operation: string; readonly deadline: number } |
  { readonly status: "waiting"; readonly until: number } | { readonly status: "held"; readonly reason: Exclude<DataVolumeCreation["reason"], null> | "authorization" | "runtime" | "history" };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Owns allocation history, not rollout policy. The caller supplies current admission/effect authority; this component never removes a volume or renews an existing operation. */
export const volumeCreationCatalog = (journal: OperationJournal, input: DataOwnership, ports: Ports) => {
  const checked = parseDataOwnership(input); if (!checked.ok) throw new Error("invalid volume catalog owner"); const owner = checked.value; claimJournal(journal, "volume catalog already has an owner");
  let pending = Promise.resolve(); let poisoned = false;
  const serial = <T>(call: () => Promise<T>) => { const result = pending.then(() => { if (poisoned) throw new Error("volume catalog synchronization uncertain; reopen"); return call(); }); pending = result.then(() => undefined, () => undefined); return result; };
  const load = async () => { const raw = await journal.read(); if (raw === undefined) return undefined; const state = parseVolumeCreationCatalog(raw); if (!same(state.owner, owner)) throw new Error("volume catalog owner disagrees"); return state; };
  const required = async () => { const state = await load(); if (state === undefined) throw new Error("volume catalog is not initialized"); return state; };
  const write = async (input: VolumeCreationCatalog) => { const value = parseVolumeCreationCatalog(input); try { await journal.write(value); } catch { poisoned = true; throw new Error("volume catalog synchronization uncertain; reopen"); } return value; };
  const next = (state: VolumeCreationCatalog) => { const sequence = state.sequence + 1; if (!Number.isSafeInteger(sequence)) throw new Error("volume catalog sequence exhausted"); return sequence; };
  const entry = (state: VolumeCreationCatalog, volume: OwnedVolume) => { const value = state.allocations.find((value) => same(value.volume, volume)); if (value === undefined) throw new Error("volume is outside registered catalog scope"); return value; };
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => { const left = Math.min(10000, deadline - ports.now()); if (!Number.isFinite(left) || left <= 0) return undefined; const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, left);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); } finally { clearTimeout(timer); }
  };
  const children = new Map<string, ReturnType<typeof dataVolumeCreation>>();
  const child = (volume: OwnedVolume, operation: string) => {
    const key = volume.allocation + ":" + operation; const known = children.get(key); if (known !== undefined) return known;
    const controller = dataVolumeCreation({ read: async () => entry(await required(), volume).creations.find((value) => value.action.operation === operation), write: async (raw: unknown) => {
      const state = await required(); const slot = entry(state, volume); const current = slot.creations.find((value) => value.action.operation === operation); const value = parseDataVolumeCreation(raw);
      if (current === undefined || current.receipt !== null && value.receipt !== current.receipt || current.recoveredReceipt !== undefined && !same(current.recoveredReceipt, value.recoveredReceipt) || value.action.operation !== operation || !same(current.action, value.action) || current.createdAt !== value.createdAt || current.deployment !== value.deployment || !same(value.owner, owner)) throw new Error("volume creator lost catalog ownership");
      await write({ ...state, sequence: next(state), allocations: state.allocations.map((item) => item === slot ? Object.freeze({ ...item, creations: Object.freeze(item.creations.map((old) => old === current ? value : old)) }) : item) });
    } }, ports);
    // eslint-disable-next-line functional/immutable-data -- one controller for each immutable creation identity
    children.set(key, controller); return controller;
  };
  const receipts = typed<RecordedVolumeReceiptsPort>(Object.freeze({ read: (volumes) => serial(async () => { const state = await required(); return volumeCatalogReceipts(state, owner, state.allocations.map((value) => value.volume)).read(volumes); }) }));
  return Object.freeze({
    receipts,
    register: (input: readonly OwnedVolume[]) => serial(async () => {
      const parsed = z.array(ownedVolumeSchema).max(128).readonly().parse(input); const state = await load();
      if (parsed.some((value) => value.app !== owner.app || value.dataOwner !== owner.dataOwner) || new Set(parsed.map((value) => value.allocation)).size !== parsed.length || new Set(parsed.map((value) => value.key)).size !== parsed.length ||
        state?.allocations.some((value) => parsed.some((item) => (item.key === value.volume.key || item.allocation === value.volume.allocation) && !same(item, value.volume)))) throw new Error("volume catalog registration conflicts");
      if (await bounded(ports.now() + 10000, () => ports.allowRegistration(owner, parsed)) !== true) throw new Error("volume catalog registration is unavailable");
      const added = parsed.filter((value) => !state?.allocations.some((item) => same(item.volume, value)));
      if (state !== undefined && added.length === 0) return state;
      return write({ version: 1, owner, sequence: state === undefined ? 1 : next(state), allocations: Object.freeze([...(state?.allocations ?? []), ...added.map((volume) => Object.freeze({ volume, creations: Object.freeze([]) }))]) });
    }),
    prepare: (input: Proposal) => serial(async () => {
      const proposal = parseDataVolumeCreation({ version: 1, ...input, owner, phase: "prepared", reason: null, attempts: 0, receipt: null }); const state = await required(); const slot = entry(state, proposal.action.volume);
      const previous = slot.creations.find((value) => value.action.operation === proposal.action.operation);
      if (previous !== undefined && (!same(previous.action, proposal.action) || previous.deployment !== proposal.deployment || previous.createdAt !== proposal.createdAt)) throw new Error("volume creation operation conflicts");
      const known = recordedCatalogBirth(slot); if (known !== undefined) return typed<Outcome>({ status: "recorded", receipt: known });
      if (previous !== undefined) return typed<Outcome>({ status: "pending", operation: previous.action.operation, deadline: previous.action.deadline });
      if (ports.now() < proposal.createdAt || ports.now() >= proposal.action.deadline) return typed<Outcome>({ status: "held", reason: "deadline" });
      if (slot.creations.length >= 64) return typed<Outcome>({ status: "held", reason: "history" });
      if (await bounded(proposal.action.deadline, () => ports.authorize(proposal)) !== true) return typed<Outcome>({ status: "held", reason: "authorization" });
      const last = slot.creations.at(-1);
      if (last !== undefined) {
        if (proposal.createdAt < last.createdAt) throw new Error("volume creation clock moved backwards");
        if (ports.now() < last.action.deadline) return typed<Outcome>({ status: "waiting", until: last.action.deadline });
        const deadline = Math.min(proposal.action.deadline, ports.now() + 10000);
        if (await bounded(deadline, () => ports.authorizeReceipt(last)) !== true) return typed<Outcome>({ status: "held", reason: "authorization" });
        const observed = await child(slot.volume, last.action.operation).inspect(deadline);
        if (observed.status === "owned") {
          const recovered = await child(slot.volume, last.action.operation).recoverReceipt(deadline);
          return typed<Outcome>(recovered.status === "owned" ? { status: "recorded", receipt: recovered.receipt } : { status: "held", reason: "runtime" });
        }
        if (observed.status !== "absent") return typed<Outcome>({ status: "held", reason: observed.status === "foreign" ? "conflict" : "runtime" });
      }
      if (ports.now() >= proposal.action.deadline || await bounded(proposal.action.deadline, () => ports.authorize(proposal)) !== true) return typed<Outcome>({ status: "held", reason: "authorization" });
      const current = await required(); const target = entry(current, proposal.action.volume); if (recordedCatalogBirth(target) !== undefined || target.creations.length !== slot.creations.length) throw new Error("volume creation history changed");
      await write({ ...current, sequence: next(current), allocations: current.allocations.map((item) => item === target ? Object.freeze({ ...item, creations: Object.freeze([...item.creations, proposal]) }) : item) });
      return typed<Outcome>({ status: "pending", operation: proposal.action.operation, deadline: proposal.action.deadline });
    }),
    tick: (volume: OwnedVolume, operation: string) => serial(async () => {
      const slot = entry(await required(), volume); if (!slot.creations.some((value) => value.action.operation === operation)) throw new Error("unknown volume creation operation");
      const known = recordedCatalogBirth(slot); if (known !== undefined) return typed<Outcome>({ status: "recorded", receipt: known });
      const observed = await child(volume, operation).tick(); const birth = recordedCatalogBirth(entry(await required(), volume));
      return typed<Outcome>(birth !== undefined ? { status: "recorded", receipt: birth } : observed.state.phase === "held" ? { status: "held", reason: observed.state.reason ?? "runtime" } : { status: "pending", operation, deadline: observed.state.action.deadline });
    }),
    recover: (volume: OwnedVolume, operation: string, deadline: number) => serial(async () => { const slot = entry(await required(), volume); if (!slot.creations.some((value) => value.action.operation === operation)) throw new Error("unknown volume creation operation"); return child(volume, operation).recoverReceipt(deadline); }),
    read: () => serial(load),
  });
};
