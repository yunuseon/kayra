import { z } from "zod";
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

export const volumeMountTargetSchema = z.string().max(1024).refine((value) => value.startsWith("/") &&
  value.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== "..") &&
  // eslint-disable-next-line no-control-regex -- control bytes cannot be canonical mount path characters
  !/[\x00-\x20\x7f:$\\]/.test(value) && !["/proc", "/sys", "/dev"].some((path) => value === path || value.startsWith(`${path}/`)));
