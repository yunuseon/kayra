import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { err, ok } from "../../lib/result.ts";
import { field, type App } from "../app.ts";
import { sha, type Sha } from "../brand.ts";

/** The builder as the deployer asks it, on platform-internal (:8081): what it answers is checked again later, never trusted. */

/** A branch, tag or full commit id to the commit it names. */
export const builderResolve = async (builder: string, app: App, ref: string) => {
  const response = await fetch(`${builder}/resolve`, { method: "POST", body: JSON.stringify({ app: app.name, ref }) }).catch(() => undefined);
  if (response === undefined) return err("the builder did not answer");
  const answer: unknown = await response.json().catch(() => undefined);
  const given = typeof answer === "object" && answer !== null ? field(answer, "sha") : undefined;
  const problem = typeof answer === "object" && answer !== null ? field(answer, "error") : undefined;
  return typeof given === "string" ? sha(given) : err(typeof problem === "string" ? problem : `resolve: HTTP ${String(response.status)}`);
};

/** The builder's NDJSON: log lines as they come, then the bundle or an error. */
export const builderPrepare = async (builder: string, app: App, commit: Sha, log: (line: string) => void) => {
  const response = await fetch(`${builder}/prepare`, {
    method: "POST",
    body: JSON.stringify({ app: app.name, sha: commit }),
    signal: AbortSignal.timeout(45 * 60_000),
  }).catch(() => undefined);
  if (response?.body == null || !response.ok) return err("the builder did not prepare a bundle");
  const lines = createInterface({ input: Readable.fromWeb(response.body) });
  const outcome = await Array.fromAsync(lines, (line: string) => {
    try {
      const message: unknown = JSON.parse(line);
      if (typeof message !== "object" || message === null) return undefined;
      const text = field(message, "log");
      if (typeof text === "string") log(text);
      const bundle = field(message, "bundle");
      const problem = field(message, "error");
      return bundle !== undefined ? ok(bundle) : typeof problem === "string" ? err(problem) : undefined;
    } catch {
      return undefined;
    }
  });
  return outcome.findLast((item) => item !== undefined) ?? err("the builder stopped without a bundle");
};
