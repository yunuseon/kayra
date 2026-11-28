import type { AppName, Owner, RunId } from "./identity.ts";
import type { JobWhy, Why } from "./reporting.ts";

export type JobName = "gc" | "renovate";
export type Work =
  | { readonly kind: "deploy"; readonly app: AppName; readonly ref: string; readonly why: Why }
  | { readonly kind: "job"; readonly job: JobName; readonly dryRun: boolean; readonly why: JobWhy };

/** The id is assigned when the request is accepted for legacy run reporting. */
export type Request = { readonly id: RunId; readonly owner: Owner; readonly work: Work };
