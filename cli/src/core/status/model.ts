import type { Server } from "../fleet/model.ts";
import type { Update } from "./updates.ts";

/** Where a server's machine is, as this checkout knows it: its inventory.ini, else OpenTofu's state. */
export type Machine =
  | { readonly kind: "found"; readonly address: string | undefined; readonly from: "inventory" | "opentofu" }
  | { readonly kind: "not-provisioned" }
  /** OpenTofu's state holds something, but no machine: a storage box, a firewall left behind. */
  | { readonly kind: "no-machine" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** How a port answered from here. */
export type Reach =
  | { readonly kind: "open"; readonly ms: number }
  | { readonly kind: "answered"; readonly status: number; readonly ms: number }
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
