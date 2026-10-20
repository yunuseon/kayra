import type { Brand } from "../lib/brand.ts";
import { err, ok } from "../lib/result.ts";

export type AppName = Brand<string, "AppName">;
/** A full commit id: what gets built, deployed and recorded. */
export type Sha = Brand<string, "Sha">;
/** `<UTC time>-<6 hex>`: sorts by start time. */
export type RunId = Brand<string, "RunId">;
export type JobName = "gc" | "renovate";
/** Whose runs a directory under runs/ holds: an app, or `_<job>` (no app name starts with `_`). */
export type Owner = Brand<string, "Owner">;

export const appName = (value: string) =>
  /^[a-z][a-z0-9-]*$/.test(value) ? ok<AppName>(value as AppName) : err(`'${value}' is not an app name`);

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

export const subdomain = (value: string) =>
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value) ? ok<Subdomain>(value as Subdomain) : err(`'${value}' is not a subdomain`);

export const serviceName = (value: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value) ? ok<ServiceName>(value as ServiceName) : err(`'${value}' is not a compose service name`);

export const port = (value: number) =>
  Number.isInteger(value) && value >= 1 && value <= 65535 ? ok<Port>(value as Port) : err(`${String(value)} is not a port`);

export const routePath = (value: string) =>
  /^\/[A-Za-z0-9._~%/-]*$/.test(value) ? ok<RoutePath>(value as RoutePath) : err(`'${value}' is not a path (/, then letters, digits and ._~%/-)`);

export const period = (value: string) =>
  /^[1-9][0-9]*(ms|s|m|h)$/.test(value) ? ok<Period>(value as Period) : err(`'${value}' is not a period such as 10s, 10m or 1h`);

export const appOwner = (app: AppName) => app as string as Owner;
export const jobOwner = (job: JobName) => `_${job}` as Owner;

export const owner = (value: string) =>
  /^(_gc|_renovate|[a-z][a-z0-9-]*)$/.test(value) ? ok<Owner>(value as Owner) : err(`'${value}' has no runs`);
