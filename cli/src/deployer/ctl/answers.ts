import type { AppName } from "../brand.ts";
import type { Deployed, Release, ReleasesAnswer, RunAnswer, RunMeta, RunsAnswer } from "../../contracts/reporting.ts";
export type { Deployed, ReleasesAnswer, RunAnswer, RunsAnswer } from "../../contracts/reporting.ts";
import { typed } from "../../lib/typed.ts";

/** A release record's compact UTC time, 20261018T101500Z, as ISO 8601. */
const iso = (compact: string) => compact.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z");

const deployed = (release: Release) => typed<Deployed>({ sha: release.sha, time: iso(release.time) });

/** One run as data: `ctl runs --json` lists them, `ctl deploy --json` answers with the one it followed. */
export const runAnswer = (run: RunMeta) => typed<RunAnswer>({
  id: run.id,
  state: run.state,
  why: run.why,
  what: run.what,
  ...(run.sha === undefined ? {} : { sha: run.sha }),
  started: run.started,
  ...(run.finished === undefined ? {} : { finished: run.finished }),
  ...(run.error === undefined ? {} : { error: run.error }),
  ...(run.urls === undefined ? {} : { urls: run.urls }),
  ...(run.checks === undefined ? {} : { checks: run.checks }),
});

export const runsAnswer = (app: AppName, runs: readonly RunMeta[], live: Release | undefined) => typed<RunsAnswer>({
  app,
  ...(live === undefined ? {} : { live: deployed(live) }),
  runs: runs.map(runAnswer),
});

export const releasesAnswer = (app: AppName, releases: readonly Release[]) => typed<ReleasesAnswer>({
  app,
  releases: releases.map((release, index) => ({ ...deployed(release), live: index === 0 } as const)),
});
