import type { SwarmAuthority } from "./swarm-authority.ts";

/** CPU is in millicores; memory is in bytes. */
export type ResourceBudget = { readonly cpu: number; readonly memory: number };
export type SwarmHostObservation =
  | { readonly status: "ready"; readonly capacity: ResourceBudget; readonly standing: ResourceBudget;
      readonly engine: string; readonly api: string; readonly node: string; readonly cluster: string; readonly network: string }
  | { readonly status: "unavailable" | "changed" | "unsupported" };
export type HostObserver = { readonly observeHost: (authority: SwarmAuthority) => Promise<SwarmHostObservation> };
