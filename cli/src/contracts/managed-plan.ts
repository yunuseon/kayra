import type { RegistrationGeneration } from "./registration-generation.ts";
import type { OwnedVolume } from "./owned-volume.ts";
import type { ManagedApplicationPlan } from "./managed-application-plan.ts";

/** Compilation consumes immutable build bytes and platform publications; allocation only reserves logical identities. */
export type ManagedPlanPort = {
  readonly volumeKeys: (registration: RegistrationGeneration, commit: string, artifact: string) => Promise<readonly string[]>;
  readonly preview: (registration: RegistrationGeneration, commit: string, artifact: string, volumes: readonly OwnedVolume[]) => Promise<ManagedApplicationPlan>;
};

export type ManagedRecreationPlanPort = {
  readonly rebind: (verified: ManagedApplicationPlan, registration: RegistrationGeneration) => Promise<ManagedApplicationPlan>;
};
