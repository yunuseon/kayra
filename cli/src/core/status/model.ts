import type { Server } from "../fleet/model.ts";
import type { Update } from "./updates.ts";
import type { Host, Milliseconds } from "../fleet/brand.ts";

/** Where a server's machine is, as this checkout knows it: its inventory.ini, else OpenTofu's state. */
export type Machine =
  | { readonly kind: "found"; readonly address: Host | undefined; readonly from: "inventory" | "opentofu" }
  | { readonly kind: "not-provisioned" }
  /** OpenTofu's state holds something, but no machine: a storage box, a firewall left behind. */
  | { readonly kind: "no-machine" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** How a port answered from here. */
export type Reach =
  | { readonly kind: "open"; readonly ms: Milliseconds }
  | { readonly kind: "answered"; readonly status: number; readonly ms: Milliseconds }
  /** Nothing listens: an on-demand SSH that is off. */
  | { readonly kind: "refused" }
  | { readonly kind: "no-answer" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "unknown-host" }
  | { readonly kind: "bad-certificate"; readonly code: string }
  | { readonly kind: "failed"; readonly code: string }
  /** Nothing to ask: no address, or --offline. */
  | { readonly kind: "skipped" };

export type Pending = { readonly kind: "pending" };

/** Every state a probe's cell can be in, as the API names them. */
export const reachStates = ["pending", "open", "answered", "refused", "no-answer", "unreachable", "unknown-host", "bad-certificate", "failed", "skipped"] as const satisfies readonly (Reach | Pending)["kind"][];

/** Every state a machine's cell can be in. */
export const machineStates = ["pending", "found", "not-provisioned", "no-machine", "unreadable"] as const satisfies readonly (Machine | Pending)["kind"][];

/** A server as status sees it; a cell is pending until its answer is in. */
export type Look = {
  readonly server: Server;
  readonly machine: Machine | Pending;
  readonly ssh: Reach | Pending;
  /** auth.<domain>: platform servers only. */
  readonly https: Reach | Pending | undefined;
};

/** A machine kayra's modules create, by its resource type; a data source is none. */
export const isMachine = (resource: string): boolean => /(?:^|\.)(?<!data\.)(?:hcloud_server|multipass_instance)\.[^.]+$/.test(resource);

export type Watched = { readonly initial: readonly Look[]; readonly updates: readonly Promise<Update<readonly Look[]>>[] };
