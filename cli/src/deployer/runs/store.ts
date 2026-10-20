import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { owner as mintOwner, runId, type Owner, type RunId } from "../brand.ts";
import { expired, parseMeta, type RunMeta } from "./records.ts";
import { typed } from "../../lib/typed.ts";

/** runs/: <owner>/<id>/{meta.json,log}. Only the deployer writes there; the builder's pages and ctl read it. */

const entries = (dir: string) => (existsSync(dir) ? readdirSync(dir).toSorted() : typed<readonly string[]>([]));

export const owners = (runs: string) =>
  Object.freeze(entries(runs).flatMap((name) => {
    const minted = mintOwner(name);
    return minted.ok ? Object.freeze([minted.value]) : Object.freeze([]);
  }));

export const meta = (runs: string, who: Owner, id: RunId) => {
  const path = join(runs, who, id, "meta.json");
  if (!existsSync(path)) return undefined;
  try {
    return parseMeta(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
};

/** Newest first. */
export const runsOf = (runs: string, who: Owner) =>
  Object.freeze(entries(join(runs, who)).toReversed().flatMap((name) => {
    const id = runId(name);
    const found = id.ok ? meta(runs, who, id.value) : undefined;
    return found === undefined ? Object.freeze([]) : Object.freeze([found]);
  }));

export const log = (runs: string, who: Owner, id: RunId) => {
  const path = join(runs, who, id, "log");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
};

/** A run's meta.json, as it begins and again as it ends. */
export const writeMeta = (runs: string, who: Owner, run: RunMeta) => {
  const dir = join(runs, who, run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(run));
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
