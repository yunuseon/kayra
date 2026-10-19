import type { AppName, Domain, FleetRoot, ServerDir, ServerName, VaultPasswordFile } from "./brand.ts";
import type { ServerKind } from "./settings.ts";

export const serverTargets = ["multipass", "hetzner", "home"] as const;

export type ServerTarget = (typeof serverTargets)[number];

export type Vault =
  | { readonly kind: "none" }
  | { readonly kind: "ask" }
  | { readonly kind: "file"; readonly file: VaultPasswordFile };

export type App = {
  readonly name: AppName;
  readonly repo: string;
  /** The server.yml entry as compact JSON, the form the app playbook takes it in. */
  readonly entry: string;
};

/** How to reach a server, as its inventory.ini says. */
export type Inventory = { readonly host: string; readonly port: string; readonly user: string; readonly key: string };

export type Server = {
  readonly name: ServerName;
  readonly dir: ServerDir;
  readonly kind: ServerKind;
  readonly target: ServerTarget;
  readonly domain: Domain;
  readonly vault: Vault;
  /** The whole secrets.yml is a vault, rather than plaintext with values vaulted inline. */
  readonly hasVaultedSecrets: boolean;
  readonly apps: readonly App[];
  /** It has a terraform/ next to it, so OpenTofu provisions something. */
  readonly hasTerraform: boolean;
  /** target home: its vars.yml describes a VM image to build. */
  readonly buildsVm: boolean;
  /** Its certificates come by DNS-01 (acme_dns in vars.yml), not from mkcert. */
  readonly usesAcmeDns: boolean;
  readonly inventory: Inventory | undefined;
  /** vars.yml's restic_backup.dir, where the backup stack runs. */
  readonly backupDir: string | undefined;
  /** What the server's own stacks route (their Traefik Host rules), relative to its domain where under it. */
  readonly stackHosts: readonly string[];
};

export type Fleet = {
  readonly root: FleetRoot;
  readonly servers: readonly Server[];
};

/** A server's files as text, read by the shell; undefined where a file is missing. */
export type ServerFiles = {
  readonly name: ServerName;
  readonly dir: ServerDir;
  readonly descriptor: string;
  readonly vars: string | undefined;
  readonly secrets: string | undefined;
  readonly inventory: string | undefined;
  readonly hasTerraform: boolean;
  /** Each stack's compose.yaml, in path order. */
  readonly stacks: readonly string[];
  /** apps/: each app's values, `<app>.yml` (config) and `<app>.secrets.yml`, by file name. */
  readonly appValues: readonly { readonly file: string; readonly text: string }[];
};
