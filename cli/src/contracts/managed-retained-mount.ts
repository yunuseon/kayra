import type { ManagedServicePlan } from "./managed-service-plan.ts";
import type { OwnedVolume } from "./owned-volume.ts";

/** Identity continuity only. Callers independently authenticate this inventory and verify unchanged specifications/inputs before reactivation; this does not grant a new service access to retired data. */
export const hasRecordedRetainedMount = (service: ManagedServicePlan, volume: OwnedVolume, recorded: readonly ManagedServicePlan[]) => recorded.some((known) => known.role === "retained-dependency" && service.role === "retained-dependency" && known.service === service.service &&
  known.owner.app === service.owner.app && known.owner.incarnation === service.owner.incarnation && known.owner.dataOwner === service.owner.dataOwner &&
  known.mounts.some((mount) => mount.volume.app === volume.app && mount.volume.dataOwner === volume.dataOwner && mount.volume.allocation === volume.allocation && mount.volume.key === volume.key && mount.volume.name === volume.name));
