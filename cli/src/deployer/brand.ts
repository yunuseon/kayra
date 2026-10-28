import type { Brand } from "../lib/brand.ts";
import type { RunId, Sha } from "../contracts/identity.ts";
export type { RunId, Sha } from "../contracts/identity.ts";
import { err, ok } from "../lib/result.ts";
import { names, type Name } from "../lib/names.ts";

export type AppName = Brand<string, "AppName">;
export type JobName = "gc" | "renovate";
/** Whose runs a directory under runs/ holds: an app, or `_<job>` (no app name starts with `_`). */
export type Owner = Brand<string, "Owner">;

/** A constructor for the brand B: the value, if it follows the name's rule (lib/names.ts, as the fleet's schemas do). */
const matching = <B extends string>({ pattern, what }: Name) => (value: string) =>
  pattern.test(value) ? ok<Brand<string, B>>(value as Brand<string, B>) : err(`'${value}' is not ${what}`);

export const appName = matching<"AppName">(names.app);

export const sha = (value: string) =>
  /^[0-9a-f]{40}$/.test(value) ? ok<Sha>(value as Sha) : err(`'${value}' is not a full commit id`);

export const runId = (value: string) =>
  /^\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(value) ? ok<RunId>(value as RunId) : err(`'${value}' is not a run id`);

export const newRunId = (now: Date, random: string) =>
  `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${random}` as RunId;

/** A route's host, `<subdomain>.<domain>`: a DNS label, so it is safe inside a Traefik rule. */
export type Subdomain = Brand<string, "Subdomain">;
/** A compose service of the app. */
export type ServiceName = Brand<string, "ServiceName">;
export type Port = Brand<number, "Port">;
/** A route's path prefix: no backtick, quote or `$`, so it cannot leave its Traefik rule or meet Compose's interpolation. */
export type RoutePath = Brand<string, "RoutePath">;
/** A Traefik duration, such as `10m`. */
export type Period = Brand<string, "Period">;

export const subdomain = matching<"Subdomain">(names.subdomain);

export const serviceName = matching<"ServiceName">(names.serviceName);

export const port = (value: number) =>
  Number.isInteger(value) && value >= 1 && value <= 65535 ? ok<Port>(value as Port) : err(`${String(value)} is not a port`);

export const routePath = matching<"RoutePath">(names.routePath);

export const period = matching<"Period">(names.period);

export const appOwner = (app: AppName) => app as string as Owner;
export const jobOwner = (job: JobName) => `_${job}` as Owner;

export const owner = (value: string) =>
  /^(_gc|_renovate|[a-z][a-z0-9-]*)$/.test(value) ? ok<Owner>(value as Owner) : err(`'${value}' has no runs`);
