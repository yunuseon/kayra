import type { BuildPorts } from "../../contracts/build-artifact.ts";
import { managedDeploymentEvidence } from "./managed-deployment-evidence.ts";
import type { ManagedRemovalInventory } from "./managed-removal-effects.ts";
import type { ManagedRemovalTombstone } from "./managed-removal-intent.ts";
import type { ManagedPurgeInventory } from "./managed-purge-inventory.ts";

/** A retired historical release can authorize reuse of data only from its verified compatibility epoch. */
export const managedRecreationBaseline = async (
  inventory: ManagedRemovalInventory,
  tombstone: ManagedRemovalTombstone,
  volumes: ManagedPurgeInventory,
  ports: Pick<BuildPorts, "read">,
) => {
  const { intent, checkpoint, blocked } = inventory;
  if (intent.request !== tombstone.request || intent.action !== tombstone.action ||
    checkpoint !== tombstone.checkpoint || blocked === null) {
    throw new Error("recreation requires an owned retired release checkpoint");
  }
  const { state } = blocked;
  if (state.operation.phase !== "complete" || !state.operation.settled || state.active?.epoch !== state.compatibilityEpoch) {
    throw new Error("recreation requires a settled release from the retired data epoch");
  }
  if (JSON.stringify(volumes.map(({ volume }) => volume)) !== JSON.stringify(intent.volumes)) {
    throw new Error("recreation requires the retired allocation inventory");
  }
  const evidence = await managedDeploymentEvidence(state, blocked.source, ports);
  if (evidence.active === null) throw new Error("recreation lacks a verified source release");
  const mounted = Object.values(evidence.active.release.source.application.services).flatMap((service) => service.mounts);
  if (mounted.some(({ volume }) => !volumes.some(({ birth }) =>
    birth !== null && JSON.stringify(birth.volume) === JSON.stringify(volume)))) {
    throw new Error("the verified release lacks a recorded birth for a mounted volume");
  }
  return Object.freeze({ removal: tombstone.request, owner: intent.owner, checkpoint,
    epoch: state.compatibilityEpoch, volumes,
    active: evidence.active, registration: intent.registration,
  });
};
