import { branded } from "../lib/brand.ts";
import { names } from "../lib/names.ts";
import { err, ok } from "../lib/result.ts";
import { typed } from "../lib/typed.ts";
import { parseSwarmGrants, type SwarmGrants } from "./swarm-authority.ts";
import type { AppName } from "./identity.ts";

const mintAppName = branded<"AppName">();

/**
 * An app as the operator registered it (`kayra apps`, the app role):
 * /opt/platform/apps/<app>.json. What may deploy where comes from here, never
 * from the app's repository: only the compose file list is read at the commit.
 */
type Registration = {
  readonly name: AppName;
  readonly repo: string;
  readonly ref: string;
  /** The app's root inside its repository. */
  readonly path: string;
  /** The hostnames its routers may claim. */
  readonly hosts: readonly string[];
  /** Secret keys, each a file under app-secrets/<app>/. */
  readonly secrets: readonly string[];
};

export type App = Registration & (
  { readonly runtime: "compose" } | { readonly runtime: "swarm"; readonly grants: SwarmGrants }
);

const strings = (value: unknown, pattern: RegExp) =>
  Array.isArray(value) && value.every((item): item is string => typeof item === "string" && pattern.test(item))
    ? typed<readonly string[]>(Object.freeze([...value]))
    : undefined;

export const field = (record: object, key: string) => {
  const value: unknown = Reflect.get(record, key);
  return value;
};

const parseRegistration = (expected: string, json: unknown) => {
  if (typeof json !== "object" || json === null) return err(`${expected}: not an object`);
  const name = field(json, "name");
  const runtime = field(json, "runtime");
  if (runtime !== undefined && runtime !== "compose" && runtime !== "swarm") return err(`${expected}: runtime must be compose or swarm`);
  const repo = field(json, "repo");
  const ref = field(json, "ref");
  const path = field(json, "path");
  const hosts = strings(field(json, "hosts"), /^[a-z0-9.-]+$/);
  const secrets = strings(field(json, "secrets"), /^[A-Z][A-Z0-9_]*$/);
  if (name !== expected) return err(`${expected}: registered as ${String(name)}`);
  const minted = names.app.pattern.test(expected) ? ok(mintAppName(expected)) : err(`'${expected}' is not ${names.app.what}`);
  if (!minted.ok) return minted;
  if (typeof repo !== "string" || !/^(https?|ssh):\/\//.test(repo)) return err(`${expected}: repo ${String(repo)}`);
  if (typeof ref !== "string" || !/^[\w./-]+$/.test(ref)) return err(`${expected}: ref ${String(ref)}`);
  if (typeof path !== "string" || path.split("/").includes("..")) return err(`${expected}: path ${String(path)}`);
  if (hosts === undefined || secrets === undefined) return err(`${expected}: hosts or secrets malformed`);
  if (runtime === "swarm") {
    if (expected.length > 48 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(expected)) return err("invalid Swarm application name");
    const grants = parseSwarmGrants(field(json, "grants"));
    if (!grants.ok) return grants;
    return ok<App>(Object.freeze({ name: minted.value, repo, ref, runtime, grants: grants.value, path, hosts, secrets }));
  }
  return ok<App>({ name: minted.value, repo, ref, runtime: "compose", path, hosts, secrets });
};

/** Immutable generation consumers require the persisted backend explicitly. */
export const parseIndexedApp = (expected: string, json: unknown) => {
  if (json === null || typeof json !== "object" || field(json, "runtime") === undefined) return err("indexed registration requires an explicit runtime");
  return parseRegistration(expected, json);
};

/** Legacy registration consumers continue to refuse every other backend. */
export const parseApp = (expected: string, json: unknown) => {
  if (json !== null && typeof json === "object" && field(json, "runtime") !== undefined && field(json, "runtime") !== "compose") return err(`${expected}: unsupported runtime; only Compose is available`);
  return parseRegistration(expected, json);
};
