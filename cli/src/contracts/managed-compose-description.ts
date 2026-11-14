import type { DescribedService } from "./compose-description.ts";

export type DeclaredVolumeMount = { readonly volume: string; readonly target: string; readonly readOnly: boolean; readonly noCopy: boolean };
export type ServiceDependency = { readonly service: string; readonly condition: "started" | "healthy" };
export type ManagedServiceDescription = DescribedService & {
  readonly mounts: readonly DeclaredVolumeMount[];
  readonly dependencies: readonly ServiceDependency[];
};
export type ManagedComposeDescription = {
  readonly services: Readonly<Record<string, ManagedServiceDescription>>;
  readonly volumes: readonly string[];
};
