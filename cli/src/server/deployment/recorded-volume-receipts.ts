import { z } from "zod";
import { ownedVolumeSchema, parseDataOwnership, volumeReceiptSchema } from "../../contracts/owned-volume.ts";
import type { DataOwnership, OwnedVolume, VolumeReceipt } from "../../contracts/owned-volume.ts";
import type { RecordedVolumeReceiptsPort } from "../../contracts/recorded-volume-receipts.ts";
import { parseDataVolumeCreation } from "./data-volume-creation.ts";
import { typed } from "../../lib/typed.ts";

const volumes = z.array(ownedVolumeSchema).max(128).readonly();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Owner-only metadata projection. Native observations never substitute for a recorded creation outcome. */
export const recordedVolumeReceipts = (input: DataOwnership, allocations: readonly OwnedVolume[], readCreation: (allocation: string) => Promise<unknown>, preserved: readonly VolumeReceipt[] = Object.freeze([])) => {
  const owner = parseDataOwnership(input); const registered = volumes.safeParse(allocations);
  if (!owner.ok || !registered.success || new Set(registered.data.map((value) => value.allocation)).size !== registered.data.length || new Set(registered.data.map((value) => value.key)).size !== registered.data.length ||
    registered.data.some((volume) => volume.app !== owner.value.app || volume.dataOwner !== owner.value.dataOwner)) throw new Error("invalid recorded volume receipt ownership");
  const inherited = z.array(volumeReceiptSchema).max(128).readonly().parse(preserved);
  if (new Set(inherited.map(({ volume }) => volume.allocation)).size !== inherited.length ||
    inherited.some(({ volume }) => !registered.data.some((known) => same(known, volume)))) throw new Error("invalid inherited volume receipts");
  return typed<RecordedVolumeReceiptsPort>(Object.freeze({
    read: async (requested) => {
      const references = volumes.safeParse(requested);
      if (!references.success || new Set(references.data.map((value) => value.allocation)).size !== references.data.length ||
        references.data.some((volume) => !registered.data.some((known) => same(known, volume)))) return undefined;
      try {
        const receipts = await Promise.all(references.data.map(async (volume) => {
          const inheritedReceipt = inherited.find(({ volume: prior }) => same(volume, prior));
          if (inheritedReceipt !== undefined) return inheritedReceipt;
          const state = parseDataVolumeCreation(await readCreation(volume.allocation)); const birth = state.receipt ?? state.recoveredReceipt?.createdAt;
          if (!same(state.owner, owner.value) || !same(state.action.volume, volume) || state.attempts === 0 || birth === undefined) throw new Error("recorded volume receipt evidence is unavailable");
          return Object.freeze({ volume, createdAt: birth });
        }));
        return Object.freeze(receipts);
      } catch { return undefined; }
    },
  }));
};
