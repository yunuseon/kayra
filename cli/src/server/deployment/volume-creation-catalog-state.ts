import { z } from "zod";
import { ownedVolumeSchema, parseDataOwnership } from "../../contracts/owned-volume.ts";
import { parseDataVolumeCreation } from "./data-volume-creation.ts";

const schema = z.object({ version: z.literal(1), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), owner: z.unknown(),
  allocations: z.array(z.object({ volume: ownedVolumeSchema, creations: z.array(z.unknown()).max(64).readonly() }).strict().readonly()).max(128).readonly(),
}).strict().readonly();
export const parseVolumeCreationCatalog = (input: unknown) => {
  const raw = schema.parse(input); const owner = parseDataOwnership(raw.owner); if (!owner.ok) throw new Error("invalid volume catalog ownership");
  const allocations = Object.freeze(raw.allocations.map((entry) => {
    const creations = Object.freeze(entry.creations.map(parseDataVolumeCreation));
    const births = creations.flatMap((value) => { const birth = value.receipt ?? value.recoveredReceipt?.createdAt; return birth === undefined ? Object.freeze([]) : Object.freeze([birth]); });
    if (entry.volume.app !== owner.value.app || entry.volume.dataOwner !== owner.value.dataOwner || new Set(creations.map((value) => value.action.operation)).size !== creations.length || new Set(births).size > 1 ||
      creations.some((value, index) => JSON.stringify(value.owner) !== JSON.stringify(owner.value) || JSON.stringify(value.action.volume) !== JSON.stringify(entry.volume) || index > 0 && value.createdAt < (creations[index - 1]?.createdAt ?? 0))) throw new Error("volume catalog creation evidence disagrees");
    return Object.freeze({ volume: entry.volume, creations });
  }));
  if (new Set(allocations.map((value) => value.volume.allocation)).size !== allocations.length || new Set(allocations.map((value) => value.volume.key)).size !== allocations.length) throw new Error("duplicate volume catalog allocation");
  return Object.freeze({ ...raw, owner: owner.value, allocations });
};
export type VolumeCreationCatalog = ReturnType<typeof parseVolumeCreationCatalog>;
