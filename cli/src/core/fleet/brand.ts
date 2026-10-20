import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { z } from "zod";
import { branded, type Brand } from "../../lib/brand.ts";
import { err, ok } from "../../lib/result.ts";
import { minting } from "../../lib/schema.ts";
import { names, type Name } from "../../lib/names.ts";

/** A string matching a name's pattern: brand it, and it is the schema the fleet's files are parsed with and the constructor everything else mints with. */
// eslint-disable-next-line functional/prefer-immutable-types -- a RegExp, and a Zod schema: immutable once built, but classes the rule cannot see into
const pattern = ({ pattern: regex, what }: Name) => z.string().regex(regex, { error: (issue) => `'${String(issue.input)}' is not ${what}` });

export const serverNameSchema = pattern({ pattern: /^[a-z0-9][a-z0-9-]*$/, what: "a server name (lowercase letters, digits, dashes)" }).transform(branded<"ServerName">());
export const appNameSchema = pattern(names.app).transform(branded<"AppName">());
export const subdomainSchema = pattern(names.subdomain).transform(branded<"Subdomain">());
export const routePathSchema = pattern(names.routePath).transform(branded<"RoutePath">());
export const serviceNameSchema = pattern(names.serviceName).transform(branded<"ServiceName">());
export const periodSchema = pattern(names.period).transform(branded<"Period">());
export const domainSchema = pattern({ pattern: /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/, what: "a domain" }).transform(branded<"Domain">());
/** A path inside a repository, never above it. */
export const repoPathSchema = z
  .string()
  .refine((value) => !`/${value}/`.includes("/../"), { error: "path must stay inside its repo" })
  .transform(branded<"RepoPath">());
/** Where an app's repository is cloned from: which schemes, the server's target says. */
export const repoUrlSchema = z.string().transform(branded<"RepoUrl">());

export type ServerName = z.output<typeof serverNameSchema>;
export type AppName = z.output<typeof appNameSchema>;
export type Subdomain = z.output<typeof subdomainSchema>;
export type Domain = z.output<typeof domainSchema>;
export type RepoPath = z.output<typeof repoPathSchema>;
export type RepoUrl = z.output<typeof repoUrlSchema>;
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
/** A path on a server. */
export type RemotePath = Brand<string, "RemotePath">;
export type Milliseconds = Brand<number, "Milliseconds">;
/** How a program ended: 0 for success; 127 where it never started, 130 where it was interrupted. */
export type ExitCode = Brand<number, "ExitCode">;
/** Which kayra runs: its package's version. */
export type KayraVersion = Brand<string, "KayraVersion">;

export const serverName = minting(serverNameSchema);
export const appName = minting(appNameSchema);
export const subdomain = minting(subdomainSchema);
export const domain = minting(domainSchema);
export const repoPath = minting(repoPathSchema);

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

export const remotePath = (value: string) =>
  value.startsWith("/") ? ok<RemotePath>(value as RemotePath) : err(`'${value}' is not an absolute path`);

export const milliseconds = (value: number) => Math.max(0, value) as Milliseconds;

export const exitCode = (value: number) => value as ExitCode;

export const kayraVersion = (value: string) =>
  /^\d+\.\d+\.\d+/.test(value) ? ok<KayraVersion>(value as KayraVersion) : err(`'${value}' is not a version`);
