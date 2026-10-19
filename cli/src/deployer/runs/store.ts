import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { owner as mintOwner, runId, type Owner, type RunId } from "../brand.ts";
import { parseMeta } from "./records.ts";
import { typed } from "../../lib/typed.ts";

/** Reading runs/: <owner>/<id>/{meta.json,log}. Only the deployer writes there. */

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
