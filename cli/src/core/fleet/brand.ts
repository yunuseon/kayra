import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { err, ok, type Result } from "../../result.ts";

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

export const serverName = (value: string): Result<ServerName, string> =>
  /^[a-z0-9][a-z0-9-]*$/.test(value)
    ? ok(value as ServerName)
    : err(`'${value}' is not a server name (lowercase letters, digits, dashes)`);

export const appName = (value: string): Result<AppName, string> =>
  /^[a-z][a-z0-9-]*$/.test(value)
    ? ok(value as AppName)
    : err(`'${value}' is not an app name (lowercase letters, digits, dashes)`);

export const subdomain = (value: string): Result<Subdomain, string> =>
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value) ? ok(value as Subdomain) : err(`'${value}' is not a subdomain`);

export const domain = (value: string): Result<Domain, string> =>
  /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(value)
    ? ok(value as Domain)
    : err(`'${value}' is not a domain`);

/** `~/…` is the operator's home, as Ansible reads it in vault_password_file. */
export const absolutePath = (value: string): Result<AbsolutePath, string> => {
  const expanded = value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(1)) : value;
  return isAbsolute(expanded) ? ok(normalize(expanded) as AbsolutePath) : err(`'${value}' is not an absolute path`);
};

export const kayraRoot = (path: AbsolutePath): KayraRoot => path as KayraRoot;
export const fleetRoot = (path: AbsolutePath): FleetRoot => path as FleetRoot;
export const serverDir = (root: FleetRoot, name: ServerName): ServerDir =>
  join(root, "servers", name) as ServerDir;
export const vaultPasswordFile = (path: AbsolutePath): VaultPasswordFile => path as VaultPasswordFile;

export const within = (base: AbsolutePath, ...segments: readonly string[]): AbsolutePath =>
  join(base, ...segments) as AbsolutePath;

/** One of each, as help shows a value: what a command-line parser offers before the operator types one. */
export const examples = {
  app: "app" as AppName,
  server: "server" as ServerName,
  domain: "example.com" as Domain,
  subdomain: "www" as Subdomain,
};
