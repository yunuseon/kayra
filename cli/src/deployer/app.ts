import { typed } from "../typed.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok } from "../result.ts";
import { appName, type AppName } from "./brand.ts";

/**
 * An app as the operator registered it (`kayra apps`, the app role):
 * /opt/platform/apps/<app>.json. What may deploy where comes from here, never
 * from the app's repository: only the compose file list is read at the commit.
 */
export type App = {
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

const strings = (value: unknown, pattern: RegExp) =>
  Array.isArray(value) && value.every((item): item is string => typeof item === "string" && pattern.test(item))
    ? typed<readonly string[]>(value)
    : undefined;

export const field = (record: object, key: string) => {
  const value: unknown = Reflect.get(record, key);
  return value;
};

export const parseApp = (expected: string, json: unknown) => {
  if (typeof json !== "object" || json === null) return err(`${expected}: not an object`);
  const name = field(json, "name");
  const repo = field(json, "repo");
  const ref = field(json, "ref");
  const path = field(json, "path");
  const hosts = strings(field(json, "hosts"), /^[a-z0-9.-]+$/);
  const secrets = strings(field(json, "secrets"), /^[A-Z][A-Z0-9_]*$/);
  if (name !== expected) return err(`${expected}: registered as ${String(name)}`);
  const minted = appName(expected);
  if (!minted.ok) return minted;
  if (typeof repo !== "string" || !/^(https?|ssh):\/\//.test(repo)) return err(`${expected}: repo ${String(repo)}`);
  if (typeof ref !== "string" || !/^[\w./-]+$/.test(ref)) return err(`${expected}: ref ${String(ref)}`);
  if (typeof path !== "string" || path.split("/").includes("..")) return err(`${expected}: path ${String(path)}`);
  if (hosts === undefined || secrets === undefined) return err(`${expected}: hosts or secrets malformed`);
  return ok<App>({ name: minted.value, repo, ref, path, hosts, secrets });
};

/** An app registered on this server, from <platformDir>/apps/<name>.json. */
export const registered = (platformDir: string, name: string) => {
  const path = join(platformDir, "apps", `${name}.json`);
  if (!appName(name).ok || !existsSync(path)) return err(`${name} is not registered here`);
  try {
    return parseApp(name, JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    return err(`${path}: ${String(error)}`);
  }
};

