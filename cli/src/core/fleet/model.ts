import type { AppName, Domain, FleetRoot, Host, KeyFile, Port, RemotePath, RepoPath, RepoUrl, ServerDir, ServerName, SshUser, VaultPasswordFile } from "./brand.ts";
import type { ServerKind } from "./settings.ts";

export const serverTargets = ["multipass", "hetzner", "home"] as const;

export type ServerTarget = (typeof serverTargets)[number];

export type Vault =
  | { readonly kind: "none" }
  | { readonly kind: "ask" }
  | { readonly kind: "file"; readonly file: VaultPasswordFile };

export type App = {
  readonly name: AppName;
  readonly repo: RepoUrl;
  /** Where in its repository the app lives. */
  readonly path: RepoPath;
  /** The server.yml entry as written: the app playbook takes it whole. */
  readonly entry: Readonly<Record<string, unknown>>;
};

/** How to reach a server, as its inventory.ini says. */
export type Inventory = { readonly host: Host | undefined; readonly port: Port; readonly user: SshUser | undefined; readonly key: KeyFile | undefined };

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
  readonly backupDir: RemotePath | undefined;
  /** What the server's own stacks route (their Traefik Host rules), relative to its domain where under it. */
  readonly stackHosts: readonly string[];
  /** vars.yml, parsed. */
  readonly vars: Readonly<Record<string, unknown>>;
  /** The files as they were read when the fleet loaded: what validate looks at beyond the schemas. */
  readonly files: {
    readonly vars: string;
    readonly secrets: string;
    /** The folders under stacks/. */
    readonly stacks: readonly string[];
    readonly appValues: ServerFiles["appValues"];
  };
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
  /** Each folder under stacks/, by name, with its compose.yaml where it has one. */
  readonly stacks: readonly { readonly name: string; readonly compose: string | undefined }[];
  /** apps/: each app's values, `<app>.yml` (config) and `<app>.secrets.yml`, by file name. */
  readonly appValues: readonly { readonly file: string; readonly text: string }[];
};
