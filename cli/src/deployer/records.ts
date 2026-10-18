import type { Why } from "./queue.ts";
import { runId, sha, type RunId, type Sha } from "./brand.ts";
import { field } from "./app.ts";

/** A release record's name: releases/<app>/<UTC time>-<sha>.env. registry-gc.sh reads the same files. */
export const releaseName = (at: Date, commit: Sha): string =>
  `${at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${commit}.env`;

export type Release = { readonly sha: Sha; readonly time: string };

/** Newest first, one per commit: the first is what runs now, the rest are what rollback offers. */
export const releases = (names: readonly string[]): readonly Release[] =>
  names
    .toSorted()
    .toReversed()
    .flatMap((name) => {
      const match = /^(\d{8}T\d{6}Z)-([0-9a-f]{40})\.env$/.exec(name);
      const commit = sha(match?.[2] ?? "");
      return match?.[1] === undefined || !commit.ok ? [] : [{ sha: commit.value, time: match[1] }];
    })
    .filter((release, i, all) => all.findIndex((other) => other.sha === release.sha) === i);

/** The poll's question: has the ref moved to a commit neither the newest run tried nor the newest release runs? */
export const moved = (resolved: Sha, lastRun: Sha | undefined, lastRelease: Sha | undefined): boolean =>
  resolved !== lastRun && resolved !== lastRelease;

export type RunState = "running" | "success" | "failure";

/** runs/<owner>/<id>/meta.json, next to its log. */
export type RunMeta = {
  readonly id: RunId;
  readonly owner: string;
  readonly what: string;
  readonly why: Why | "schedule" | "manual";
  readonly sha?: Sha;
  readonly state: RunState;
  readonly started: string;
  readonly finished?: string;
};

const whys = ["push", "poll", "deploy", "rollback", "schedule", "manual"] as const;
const states = ["running", "success", "failure"] as const;
const isWhy = (value: unknown): value is RunMeta["why"] => whys.some((why) => why === value);
const isState = (value: unknown): value is RunState => states.some((state) => state === value);

export const parseMeta = (json: unknown): RunMeta | undefined => {
  if (typeof json !== "object" || json === null) return undefined;
  const id = runId(String(field(json, "id")));
  const owner = field(json, "owner");
  const what = field(json, "what");
  const why = field(json, "why");
  const commit = sha(String(field(json, "sha")));
  const state = field(json, "state");
  const started = field(json, "started");
  const finished = field(json, "finished");
  if (!id.ok || typeof owner !== "string" || typeof what !== "string" || typeof started !== "string") return undefined;
  if (!isWhy(why) || !isState(state)) return undefined;
  return {
    id: id.value,
    owner,
    what,
    why,
    state,
    started,
    ...(commit.ok ? { sha: commit.value } : {}),
    ...(typeof finished === "string" ? { finished } : {}),
  };
};

/** Run directories past the newest `keep`, oldest first: what retention deletes. */
export const expired = (ids: readonly string[], keep: number): readonly string[] => ids.toSorted().slice(0, Math.max(0, ids.length - keep));
