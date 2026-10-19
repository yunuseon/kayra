import { err, ok } from "../result.ts";

declare const brands: unique symbol;
/** A T that only the matching constructor below can produce. */
export type Brand<T, B extends string> = T & { readonly [brands]: Readonly<Record<B, true>> };

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

export const appOwner = (app: AppName) => app as string as Owner;
export const jobOwner = (job: JobName) => `_${job}` as Owner;

export const owner = (value: string) =>
  /^(_gc|_renovate|[a-z][a-z0-9-]*)$/.test(value) ? ok<Owner>(value as Owner) : err(`'${value}' has no runs`);
