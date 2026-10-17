import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { owner as mintOwner, runId, type Owner, type RunId } from "./brand.ts";
import { parseMeta, type RunMeta } from "./records.ts";

/** Reading runs/: <owner>/<id>/{meta.json,log}. Only the deployer writes there. */

const entries = (dir: string): readonly string[] => (existsSync(dir) ? readdirSync(dir).toSorted() : []);

export const owners = (runs: string): readonly Owner[] =>
  entries(runs).flatMap((name) => {
    const minted = mintOwner(name);
    return minted.ok ? [minted.value] : [];
  });

export const meta = (runs: string, who: Owner, id: RunId): RunMeta | undefined => {
  const path = join(runs, who, id, "meta.json");
  if (!existsSync(path)) return undefined;
  try {
    return parseMeta(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
};

/** Newest first. */
export const runsOf = (runs: string, who: Owner): readonly RunMeta[] =>
  entries(join(runs, who)).toReversed().flatMap((name) => {
    const id = runId(name);
    const found = id.ok ? meta(runs, who, id.value) : undefined;
    return found === undefined ? [] : [found];
  });

export const log = (runs: string, who: Owner, id: RunId): string | undefined => {
  const path = join(runs, who, id, "log");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
};
