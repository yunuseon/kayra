import type { DataOwnership, OwnedVolume } from "../../contracts/owned-volume.ts";
import { parseVolumeCreationCatalog, recordedCatalogBirth } from "./volume-creation-catalog-state.ts";

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** A purge can delete only a recorded birth. An unresolved create can still win after an absence observation. */
export const managedPurgeInventory = (input: unknown, owner: DataOwnership, volumes: readonly OwnedVolume[]) => {
  const catalog = parseVolumeCreationCatalog(input);
  if (!same(catalog.owner, owner) || volumes.some((volume) => volume.app !== owner.app || volume.dataOwner !== owner.dataOwner) ||
    catalog.allocations.some((entry) => !volumes.some((volume) => same(volume, entry.volume)))) {
    throw new Error("managed purge volume catalog lacks owned scope");
  }
  if (catalog.allocations.some((entry) => entry.creations.some((creation) =>
    creation.attempts > 0 && creation.receipt === null && creation.recoveredReceipt === undefined))) {
    throw new Error("managed purge requires resolution of uncertain volume creation");
  }
  return Object.freeze(volumes.map((volume) => {
    const slot = catalog.allocations.find((entry) => same(entry.volume, volume));
    return Object.freeze({ volume, birth: slot === undefined ? null : recordedCatalogBirth(slot) ?? null });
  }));
};
export type ManagedPurgeInventory = ReturnType<typeof managedPurgeInventory>;
