import type { OwnedVolume, VolumeReceipt } from "./owned-volume.ts";

/** Read deployment-owned creation evidence. Native observation alone must never mint replacement creation receipts. */
export type RecordedVolumeReceiptsPort = {
  readonly read: (volumes: readonly OwnedVolume[]) => Promise<readonly VolumeReceipt[] | undefined>;
};
