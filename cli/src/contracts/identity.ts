import type { Brand } from "../lib/brand.ts";

/** A full commit id: what gets built, deployed and recorded. */
export type Sha = Brand<string, "Sha">;
/** `<UTC time>-<6 hex>`: sorts by start time. */
export type RunId = Brand<string, "RunId">;
