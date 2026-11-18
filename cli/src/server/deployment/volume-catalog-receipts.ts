import type { DataOwnership, OwnedVolume } from "../../contracts/owned-volume.ts";
import { parseVolumeCreationCatalog } from "./volume-creation-catalog-state.ts";
import { recordedVolumeReceipts } from "./recorded-volume-receipts.ts";

/** Deployment-owned projection. It validates the entire history before selecting any birth; callers never infer creation from native state. */
export const volumeCatalogReceipts = (input: unknown, owner: DataOwnership, registered: readonly OwnedVolume[]) => {
  const state = parseVolumeCreationCatalog(input);
  if (JSON.stringify(state.owner) !== JSON.stringify(owner) || state.allocations.some((slot) => !registered.some((volume) => JSON.stringify(volume) === JSON.stringify(slot.volume)))) throw new Error("volume catalog lacks indexed ownership");
  return recordedVolumeReceipts(owner, registered, (allocation) => Promise.resolve(state.allocations.find((slot) => slot.volume.allocation === allocation)?.creations.find((value) => value.receipt !== null || value.recoveredReceipt !== undefined)));
};
