import type { JobWhy, Why } from "./queue.ts";
import { runId, sha, type RunId, type Sha } from "../brand.ts";
import { field } from "../app.ts";
import { typed } from "../../lib/typed.ts";

/** A release record's name: releases/<app>/<UTC time>-<sha>.env. registry-gc.sh reads the same files. */
export const releaseName = (at: Date, commit: Sha) =>
  `${at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${commit}.env`;

export type Release = { readonly sha: Sha; readonly time: string };

/** Newest first, one per commit: the first is what runs now, the rest are what rollback offers. */
export const releases = (names: readonly string[]) =>
  Object.freeze(names
    .toSorted()
    .toReversed()
    .flatMap((name) => {
      const match = /^(\d{8}T\d{6}Z)-([0-9a-f]{40})\.env$/.exec(name);
      const commit = sha(match?.[2] ?? "");
      return match?.[1] === undefined || !commit.ok ? Object.freeze([]) : Object.freeze([typed<Release>({ sha: commit.value, time: match[1] })]);
    })
    .filter((release, i, all) => all.findIndex((other) => other.sha === release.sha) === i));

/** The poll's question: has the ref moved to a commit neither the newest run tried nor the newest release runs? */
export const moved = (resolved: Sha, lastRun: Sha | undefined, lastRelease: Sha | undefined) =>
  resolved !== lastRun && resolved !== lastRelease;

/** queued until it starts; superseded when a newer request for its owner replaced it before it began. */
export type RunState = "queued" | "running" | "success" | "failure" | "superseded";

/** A route's readiness after up: the URL asked through Traefik, and what answered (0: nothing did). */
export type Check = { readonly url: string; readonly status: number; readonly ok: boolean };

/** runs/<owner>/<id>/meta.json, next to its log. */
export type RunMeta = {
  readonly id: RunId;
  readonly owner: string;
  readonly what: string;
  readonly why: Why | JobWhy;
  readonly sha?: Sha;
  readonly state: RunState;
  readonly started: string;
  readonly finished?: string;
  /** Why a run failed, in one line. */
  readonly error?: string;
  /** Where the deployed app answers. */
  readonly urls?: readonly string[];
  readonly checks?: readonly Check[];
};

const whys = ["push", "poll", "deploy", "rollback", "schedule", "manual"] as const;
const states = ["queued", "running", "success", "failure", "superseded"] as const;
const isWhy = (value: unknown): value is RunMeta["why"] => whys.some((why) => why === value);
const isState = (value: unknown): value is RunState => states.some((state) => state === value);

/** A run that will change no more. */
export const ended = (state: RunState) => state === "success" || state === "failure" || state === "superseded";

const parseCheck = (json: unknown) => {
  if (typeof json !== "object" || json === null) return Object.freeze([]);
  const url = field(json, "url");
  const status = field(json, "status");
  const passed = field(json, "ok");
  return typeof url === "string" && typeof status === "number" && typeof passed === "boolean"
    ? Object.freeze([typed<Check>({ url, status, ok: passed })])
    : Object.freeze([]);
};

const texts = (json: unknown) =>
  Array.isArray(json) && json.every((each) => typeof each === "string") ? Object.freeze(json.map(String)) : undefined;

export const parseMeta = (json: unknown) => {
  if (typeof json !== "object" || json === null) return undefined;
  const id = runId(String(field(json, "id")));
  const owner = field(json, "owner");
  const what = field(json, "what");
  const why = field(json, "why");
  const commit = sha(String(field(json, "sha")));
  const state = field(json, "state");
  const started = field(json, "started");
  const finished = field(json, "finished");
  const error = field(json, "error");
  const urls = texts(field(json, "urls"));
  const checks = field(json, "checks");
  if (!id.ok || typeof owner !== "string" || typeof what !== "string" || typeof started !== "string") return undefined;
  if (!isWhy(why) || !isState(state)) return undefined;
  return typed<RunMeta | undefined>({
    id: id.value,
    owner,
    what,
    why,
    state,
    started,
    ...(commit.ok ? { sha: commit.value } : {}),
    ...(typeof finished === "string" ? { finished } : {}),
    ...(typeof error === "string" ? { error } : {}),
    ...(urls === undefined ? {} : { urls }),
    ...(Array.isArray(checks) ? { checks: Object.freeze(checks.flatMap(parseCheck)) } : {}),
  });
};

/** Run directories past the newest `keep`, oldest first: what retention deletes. */
export const expired = (ids: readonly string[], keep: number) => Object.freeze(ids.toSorted().slice(0, Math.max(0, ids.length - keep)));
