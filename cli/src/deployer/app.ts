import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { err } from "../lib/result.ts";
import { parseApp } from "../contracts/app-registration.ts";
import { appName } from "./brand.ts";

export { field, parseApp, type App } from "../contracts/app-registration.ts";

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


/** Valid registrations and names of records that cannot be used safely. */
export const registrations = (platformDir: string) => {
  const dir = join(platformDir, "apps");
  const records = (existsSync(dir) ? readdirSync(dir) : []).flatMap((file) => {
    if (!file.endsWith(".json")) return Object.freeze([]);
    const name = file.slice(0, -5);
    const result = registered(platformDir, name);
    return Object.freeze([result.ok ? Object.freeze({ app: result.value }) : Object.freeze({ invalid: appName(name).ok ? name : "invalid filename" })]);
  });
  return Object.freeze({
    apps: Object.freeze(records.flatMap((record) => "app" in record ? Object.freeze([record.app]) : Object.freeze([]))),
    invalid: Object.freeze(records.flatMap((record) => "invalid" in record ? Object.freeze([record.invalid]) : Object.freeze([]))),
  });
};
