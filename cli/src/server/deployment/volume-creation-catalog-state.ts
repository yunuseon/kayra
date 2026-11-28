import { z } from "zod";
import { ownedVolumeSchema, parseDataOwnership, volumeReceiptSchema } from "../../contracts/owned-volume.ts";
import type { DataOwnership, OwnedVolume, VolumeReceipt } from "../../contracts/owned-volume.ts";
import type { DataVolumeCreation } from "./data-volume-creation.ts";
import { parseDataVolumeCreation } from "./data-volume-creation.ts";

const inheritedBirth = z.object({
  from: z.unknown(),
  removal: z.uuid(),
  receipt: volumeReceiptSchema,
}).strict().readonly();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

const schema = z.object({ version: z.literal(1), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), owner: z.unknown(),
  allocations: z.array(z.object({
    volume: ownedVolumeSchema,
    creations: z.array(z.unknown()).max(64).readonly(),
    inherited: inheritedBirth.exactOptional(),
  }).strict().readonly()).max(128).readonly(),
}).strict().readonly();
type CatalogAllocation = {
  readonly volume: OwnedVolume;
  readonly creations: readonly DataVolumeCreation[];
  readonly inherited?: { readonly from: DataOwnership; readonly removal: string; readonly receipt: VolumeReceipt };
};
export const parseVolumeCreationCatalog = (input: unknown) => {
  const raw = schema.parse(input); const owner = parseDataOwnership(raw.owner); if (!owner.ok) throw new Error("invalid volume catalog ownership");
  const allocations = Object.freeze(raw.allocations.map<CatalogAllocation>((entry) => {
    const creations = Object.freeze(entry.creations.map(parseDataVolumeCreation));
    const births = creations.flatMap((value) => { const birth = value.receipt ?? value.recoveredReceipt?.createdAt; return birth === undefined ? Object.freeze([]) : Object.freeze([birth]); });
    if (entry.volume.app !== owner.value.app || entry.volume.dataOwner !== owner.value.dataOwner || new Set(creations.map((value) => value.action.operation)).size !== creations.length || new Set(births).size > 1 ||
      creations.some((value, index) => JSON.stringify(value.owner) !== JSON.stringify(owner.value) || JSON.stringify(value.action.volume) !== JSON.stringify(entry.volume) || index > 0 && value.createdAt < (creations[index - 1]?.createdAt ?? 0))) throw new Error("volume catalog creation evidence disagrees");
    if (entry.inherited === undefined) return Object.freeze({ volume: entry.volume, creations });
    const from = parseDataOwnership(entry.inherited.from);
    if (!from.ok || from.value.app !== owner.value.app || from.value.dataOwner !== owner.value.dataOwner ||
      from.value.incarnation === owner.value.incarnation || creations.length !== 0 ||
      !same(entry.inherited.receipt.volume, entry.volume)) throw new Error("inherited volume birth disagrees");
    return Object.freeze({ volume: entry.volume, creations, inherited: Object.freeze({ ...entry.inherited, from: from.value }) });
  }));
  if (new Set(allocations.map((value) => value.volume.allocation)).size !== allocations.length || new Set(allocations.map((value) => value.volume.key)).size !== allocations.length) throw new Error("duplicate volume catalog allocation");
  return Object.freeze({ ...raw, owner: owner.value, allocations });
};
export type VolumeCreationCatalog = ReturnType<typeof parseVolumeCreationCatalog>;

/** Select only validated durable birth evidence. A missing receipt is never reconstructed from a volume name. */
export const recordedCatalogBirth = (slot: VolumeCreationCatalog["allocations"][number]) => {
  if (slot.inherited !== undefined) return slot.inherited.receipt;
  const birth = slot.creations.find((creation) => creation.receipt !== null || creation.recoveredReceipt !== undefined);
  const createdAt = birth?.receipt ?? birth?.recoveredReceipt?.createdAt;
  return createdAt === undefined ? undefined : Object.freeze({ volume: slot.volume, createdAt });
};
