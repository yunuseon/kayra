import type { Brand } from "../lib/brand.ts";

/** A registered application's validated name. */
export type AppName = Brand<string, "AppName">;
/** The owner of legacy application or platform job run records. */
export type Owner = Brand<string, "Owner">;
/** A full commit id: what gets built, deployed and recorded. */
export type Sha = Brand<string, "Sha">;
/** `<UTC time>-<6 hex>`: sorts by start time. */
export type RunId = Brand<string, "RunId">;
