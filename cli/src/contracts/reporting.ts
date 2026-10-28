import type { RunId, Sha } from "./identity.ts";

export type Why = "push" | "poll" | "deploy" | "rollback" | "restore";
export type JobWhy = "schedule" | "manual";
export type RunState = "queued" | "running" | "success" | "failure" | "superseded";
export type Check = { readonly url: string; readonly status: number; readonly ok: boolean };
export type Release = { readonly sha: Sha; readonly time: string };

/** Legacy run records may be unverified; these facts do not establish an active release. */
export type RunMeta = {
  readonly id: RunId;
  readonly owner: string;
  readonly what: string;
  readonly why: Why | JobWhy;
  readonly sha?: Sha;
  readonly state: RunState;
  readonly started: string;
  readonly finished?: string;
  readonly error?: string;
  readonly urls?: readonly string[];
  readonly checks?: readonly Check[];
};

/** The legacy ctl wire format; consumers validate it independently. */
export type RunAnswer = {
  readonly id: string;
  readonly state: RunState;
  readonly why: string;
  readonly what: string;
  readonly sha?: string;
  readonly started: string;
  readonly finished?: string;
  readonly error?: string;
  readonly urls?: readonly string[];
  readonly checks?: readonly Check[];
};
export type Deployed = { readonly sha: string; readonly time: string };
export type RunsAnswer = { readonly app: string; readonly live?: Deployed; readonly runs: readonly RunAnswer[] };
export type ReleasesAnswer = { readonly app: string; readonly releases: readonly (Deployed & { readonly live: boolean })[] };
