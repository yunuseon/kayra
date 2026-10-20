import type { Server } from "../fleet/model.ts";
import type { Update } from "./updates.ts";
import type { Host, KayraVersion, Milliseconds } from "../fleet/brand.ts";

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

/** Which kayra set a server up, as the file its setup wrote says (the kayra-version role). */
export type Running =
  | { readonly kind: "recorded"; readonly version: KayraVersion }
  /** No such file: set up by a kayra from before one was recorded. */
  | { readonly kind: "unrecorded" }
  /** SSH failed, or the file holds no version. */
  | { readonly kind: "unreadable"; readonly reason: string }
  /** Nothing to ask: SSH not open, no inventory to log in with, or --offline. */
  | { readonly kind: "skipped" };

export type Pending = { readonly kind: "pending" };

/** Every state a probe's cell can be in, as the API names them. */
export const reachStates = ["pending", "open", "answered", "refused", "no-answer", "unreachable", "unknown-host", "bad-certificate", "failed", "skipped"] as const satisfies readonly (Reach | Pending)["kind"][];

/** Every state the running kayra's cell can be in. */
export const runningStates = ["pending", "recorded", "unrecorded", "unreadable", "skipped"] as const satisfies readonly (Running | Pending)["kind"][];

/** Every state a machine's cell can be in. */
export const machineStates = ["pending", "found", "not-provisioned", "no-machine", "unreadable"] as const satisfies readonly (Machine | Pending)["kind"][];

/** A server as status sees it; a cell is pending until its answer is in. */
export type Look = {
  readonly server: Server;
  readonly machine: Machine | Pending;
  readonly ssh: Reach | Pending;
  /** auth.<domain>: platform servers only. */
  readonly https: Reach | Pending | undefined;
  /** Which kayra set it up, read over SSH once SSH is open. */
  readonly kayra: Running | Pending;
  /** The kayra this is, the one the fleet pins: what a setup now would record. */
  readonly pin: KayraVersion;
};

/** A machine kayra's modules create, by its resource type; a data source is none. */
export const isMachine = (resource: string) => /(?:^|\.)(?<!data\.)(?:hcloud_server|multipass_instance)\.[^.]+$/.test(resource);

export type Watched = { readonly initial: readonly Look[]; readonly updates: readonly Promise<Update<readonly Look[]>>[] };
