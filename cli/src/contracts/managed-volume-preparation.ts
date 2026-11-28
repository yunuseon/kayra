import type { DataOwnership, OwnedVolume } from "./owned-volume.ts";

/** Explicit coordinator intent. It grants no effects without the current admission/parent permission callback. */
export type ManagedVolumePreparation = {
  readonly owner: DataOwnership; readonly run: string; readonly plan: string;
  readonly createdAt: number; readonly deadline: number; readonly volumes: readonly OwnedVolume[];
};
export type ManagedVolumePreparationPort = {
  readonly reconcile: (intent: ManagedVolumePreparation, allowed: () => Promise<boolean>) => Promise<"ready" | "pending" | "held">;
};
