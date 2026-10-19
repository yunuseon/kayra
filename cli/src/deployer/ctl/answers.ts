import type { AppName } from "../brand.ts";
import type { Release, RunMeta, RunState } from "../runs/records.ts";
import { typed } from "../../lib/typed.ts";

/**
 * What `ctl … --json` answers, for kayra on the operator's machine to draw:
 * plain data, every time in ISO 8601. Between a kayra bump and the server's
 * deploy a newer kayra may ask an older ctl, so kayra prints anything else as it came.
 */
export type RunAnswer = {
  readonly id: string;
  readonly state: RunState;
  readonly why: string;
  readonly what: string;
  readonly sha?: string;
  readonly started: string;
  readonly finished?: string;
};

export type Deployed = { readonly sha: string; readonly time: string };

/** `ctl runs <app> --json`: the newest runs first, and what runs now. */
export type RunsAnswer = { readonly app: string; readonly live?: Deployed; readonly runs: readonly RunAnswer[] };

/** `ctl rollback <app> --json`: every release, newest first; the first is live. */
export type ReleasesAnswer = { readonly app: string; readonly releases: readonly (Deployed & { readonly live: boolean })[] };

/** A release record's compact UTC time, 20261018T101500Z, as ISO 8601. */
const iso = (compact: string) => compact.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z");

const deployed = (release: Release) => typed<Deployed>({ sha: release.sha, time: iso(release.time) });

const answer = (run: RunMeta) => typed<RunAnswer>({
  id: run.id,
  state: run.state,
  why: run.why,
  what: run.what,
  ...(run.sha === undefined ? {} : { sha: run.sha }),
  started: run.started,
  ...(run.finished === undefined ? {} : { finished: run.finished }),
});

export const runsAnswer = (app: AppName, runs: readonly RunMeta[], live: Release | undefined) => typed<RunsAnswer>({
  app,
  ...(live === undefined ? {} : { live: deployed(live) }),
  runs: runs.map(answer),
});

export const releasesAnswer = (app: AppName, releases: readonly Release[]) => typed<ReleasesAnswer>({
  app,
  releases: releases.map((release, index) => ({ ...deployed(release), live: index === 0 } as const)),
});
