import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Owner, RunId } from "../brand.ts";
import { ended, expired, type RunMeta } from "./records.ts";
import { owners, runsOf } from "./read.ts";

/** Compatibility exports for existing deployer callers. */
export { log, meta, owners, runsOf } from "./read.ts";

/** A run's meta.json, as it begins and again as it ends. */
export const writeMeta = (runs: string, who: Owner, run: RunMeta) => {
  const dir = join(runs, who, run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(run));
};

/** Legacy interrupted runs are reported as failed; their effects are not recovered here. */
export const abandonInterruptedRuns = (runs: string, now: () => string) => {
  owners(runs).forEach((who) => {
    runsOf(runs, who)
      .filter((run) => !ended(run.state))
      .forEach((run) => {
        writeMeta(runs, who, { ...run, state: "failure", error: "the deployer restarted before this run ended", finished: now() });
      });
  });
};

/** A line of a run's log, stamped with the time of day. */
export const appendLog = (runs: string, who: Owner, id: RunId, line: string) => {
  appendFileSync(join(runs, who, id, "log"), `${new Date().toISOString().slice(11, 19)} ${line}\n`);
};

/** An owner's runs beyond the newest `keep`, gone. */
export const prune = (runs: string, who: Owner, keep: number) => {
  expired(readdirSync(join(runs, who)), keep).forEach((old) => {
    rmSync(join(runs, who, old), { recursive: true, force: true });
  });
};
