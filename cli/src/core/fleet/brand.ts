import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { err, ok } from "../../result.ts";

declare const brands: unique symbol;
/** A T that only the matching constructor below can produce. */
export type Brand<T, B extends string> = T & { readonly [brands]: Readonly<Record<B, true>> };

export type ServerName = Brand<string, "ServerName">;
export type AppName = Brand<string, "AppName">;
export type Subdomain = Brand<string, "Subdomain">;
export type Domain = Brand<string, "Domain">;
export type AbsolutePath = Brand<string, "AbsolutePath">;
/** The engine: a kayra checkout, or the package a fleet installed. */
export type KayraRoot = Brand<AbsolutePath, "KayraRoot">;
/** The configuration: the directory holding servers/. */
export type FleetRoot = Brand<AbsolutePath, "FleetRoot">;
export type ServerDir = Brand<AbsolutePath, "ServerDir">;
export type VaultPasswordFile = Brand<AbsolutePath, "VaultPasswordFile">;
/** A machine's name or address, as ssh and the network take it. */
export type Host = Brand<string, "Host">;
/** A TCP port, as its digits. */
export type Port = Brand<string, "Port">;
export type SshUser = Brand<string, "SshUser">;
/** An ssh private key, as the inventory names it. */
export type KeyFile = Brand<string, "KeyFile">;
/** Where an app's repository is cloned from. */
export type RepoUrl = Brand<string, "RepoUrl">;
/** A path inside a repository, never above it. */
export type RepoPath = Brand<string, "RepoPath">;
/** A path on a server. */
export type RemotePath = Brand<string, "RemotePath">;
export type Milliseconds = Brand<number, "Milliseconds">;
/** How a program ended: 0 for success; 127 where it never started, 130 where it was interrupted. */
export type ExitCode = Brand<number, "ExitCode">;
/** Which kayra runs: its package's version. */
export type KayraVersion = Brand<string, "KayraVersion">;

export const serverName = (value: string) =>
  /^[a-z0-9][a-z0-9-]*$/.test(value)
    ? ok<ServerName>(value as ServerName)
    : err(`'${value}' is not a server name (lowercase letters, digits, dashes)`);

export const appName = (value: string) =>
  /^[a-z][a-z0-9-]*$/.test(value)
    ? ok<AppName>(value as AppName)
    : err(`'${value}' is not an app name (lowercase letters, digits, dashes)`);

export const subdomain = (value: string) =>
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value) ? ok<Subdomain>(value as Subdomain) : err(`'${value}' is not a subdomain`);

export const domain = (value: string) =>
  /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(value)
    ? ok<Domain>(value as Domain)
    : err(`'${value}' is not a domain`);

/** `~/…` is the operator's home, as Ansible reads it in vault_password_file. */
export const absolutePath = (value: string) => {
  const expanded = value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(1)) : value;
  return isAbsolute(expanded) ? ok<AbsolutePath>(normalize(expanded) as AbsolutePath) : err(`'${value}' is not an absolute path`);
};

export const kayraRoot = (path: AbsolutePath) => path as KayraRoot;
export const fleetRoot = (path: AbsolutePath) => path as FleetRoot;
export const serverDir = (root: FleetRoot, name: ServerName) =>
  join(root, "servers", name) as ServerDir;
export const vaultPasswordFile = (path: AbsolutePath) => path as VaultPasswordFile;

export const within = (base: AbsolutePath, ...segments: readonly string[]) =>
  join(base, ...segments) as AbsolutePath;

/** One of each, as help shows a value: what a command-line parser offers before the operator types one. */
export const examples = {
  app: "app" as AppName,
  server: "server" as ServerName,
  domain: "example.com" as Domain,
  subdomain: "www" as Subdomain,
};

/** A word without whitespace: what an inventory gives for a host, a user or a key. */
const word = <T extends string>(what: string, mint: (value: string) => T) => (value: string) =>
  /^\S+$/.test(value) ? ok<T>(mint(value)) : err(`'${value}' is not ${what}`);

export const host = word("a host", (value) => value as Host);
export const sshUser = word("an ssh user", (value) => value as SshUser);
export const keyFile = word("a key file", (value) => value as KeyFile);

/** Where ssh listens unless the inventory says otherwise. */
export const sshDefaultPort = "22" as Port;

export const port = (value: string) =>
  /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? ok<Port>(value as Port) : err(`'${value}' is not a port`);

/** HTTPS, or also plain HTTP where `schemes` allow it (a multipass server, a test machine by definition). */
export const repoUrl = (value: string, schemes: readonly string[]) =>
  schemes.some((scheme) => value.startsWith(scheme)) ? ok<RepoUrl>(value as RepoUrl) : err(`'${value}' is not a ${schemes.join(" or ")} URL`);

export const repoPath = (value: string) =>
  `/${value}/`.includes("/../") ? err(`'${value}' leaves its repository`) : ok<RepoPath>(value as RepoPath);

export const remotePath = (value: string) =>
  value.startsWith("/") ? ok<RemotePath>(value as RemotePath) : err(`'${value}' is not an absolute path`);

export const milliseconds = (value: number) => Math.max(0, value) as Milliseconds;

export const exitCode = (value: number) => value as ExitCode;

export const kayraVersion = (value: string) =>
  /^\d+\.\d+\.\d+/.test(value) ? ok<KayraVersion>(value as KayraVersion) : err(`'${value}' is not a version`);
