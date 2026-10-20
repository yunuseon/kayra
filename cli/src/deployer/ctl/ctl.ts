import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { releasesAnswer, runAnswer, runsAnswer } from "./answers.ts";
import { field } from "../app.ts";
import { appOwner, appName, owner as mintOwner, runId, type Owner, type RunId } from "../brand.ts";
import { ended, releases, type RunMeta } from "../runs/records.ts";
import { log, meta, runsOf } from "../runs/store.ts";
import { typed } from "../../lib/typed.ts";

/**
 * The operator's side, run inside the deployer container by `kayra app …` and
 * `kayra job …` over SSH. Reads runs/ and releases/ directly; anything that
 * starts a run goes through the daemon's control port, so the queue stays the
 * only place runs begin. `--json` makes `runs` and rollback's list answer as
 * data (answers.ts), which kayra draws.
 */
const platformDir = process.env["PLATFORM_DIR"] ?? "/opt/platform";
const runs = join(platformDir, "runs");

const fail = (message: string) => {
  console.error(message);
  return 1;
};

type Accepted = { readonly id: RunId; readonly owner: Owner };

/** What the control port answers a request it took: the run's id, whose run it is. */
const accepted = (text: string) => {
  try {
    const json: unknown = JSON.parse(text);
    const id = runId(String(typeof json === "object" && json !== null ? field(json, "id") : ""));
    const owner = mintOwner(String(typeof json === "object" && json !== null ? field(json, "owner") : ""));
    return typed<Accepted | undefined>(id.ok && owner.ok ? { id: id.value, owner: owner.value } : undefined);
  } catch {
    return undefined;
  }
};

type Posted = { readonly code: number; readonly run?: Accepted };

const post = async (path: string, payload: object) => {
  const response = await fetch(`http://127.0.0.1:8091${path}`, { method: "POST", body: JSON.stringify(payload) }).catch(() => undefined);
  if (response === undefined) return typed<Posted>({ code: fail("the deployer is not running") });
  const text = await response.text();
  if (!response.ok) return typed<Posted>({ code: fail(text.trim()) });
  const run = accepted(text);
  return typed<Posted>(run === undefined ? { code: fail(`the deployer answered what this ctl cannot read: ${text.trim()}`) } : { code: 0, run });
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The run's end, in a few lines: what runs where, or why not. */
const summary = (run: RunMeta) => {
  const commit = run.sha === undefined ? "" : ` ${run.sha.slice(0, 7)}`;
  if (run.state === "superseded") return typed<readonly string[]>([`↷ ${run.owner}: a newer request replaced this one before it started (run ${run.id})`]);
  if (run.state === "failure") return typed<readonly string[]>([`✗ ${run.owner}${commit}: ${run.error ?? "failed; see the log"} (run ${run.id})`]);
  return typed<readonly string[]>([`✓ ${run.owner}${commit} deployed (run ${run.id})`, ...(run.urls ?? []).map((url) => `  ${url}`)]);
};

/**
 * Follows a run until it ends: its log as it grows (unless `json`), then its
 * end — the run as data with `json`. Exits 0 only on success.
 */
const follow = async (who: Owner, id: RunId, json: boolean, shown = 0): Promise<number> => {
  const text = log(runs, who, id) ?? "";
  if (!json && text.length > shown) process.stdout.write(text.slice(shown));
  const now = meta(runs, who, id);
  if (now === undefined) return fail(`run ${id} of ${who} is gone`);
  if (!ended(now.state)) {
    await pause(1_000);
    return follow(who, id, json, text.length);
  }
  if (json) console.log(JSON.stringify(runAnswer(now)));
  else summary(now).forEach((line) => { console.log(line); });
  return now.state === "success" ? 0 : 1;
};

const start = async (payload: object, json: boolean) => {
  const posted = await post("/deploy", payload);
  return posted.run === undefined ? posted.code : follow(posted.run.owner, posted.run.id, json);
};

const releasesOf = (app: string) => {
  const dir = join(platformDir, "releases", app);
  return releases(existsSync(dir) ? readdirSync(dir) : []);
};

const commands: Readonly<Record<string, (args: readonly string[], json: boolean) => Promise<number> | number>> = {
  runs: ([app], json) => {
    const name = appName(app ?? "");
    if (!name.ok) return fail(name.error);
    const latest = runsOf(runs, appOwner(name.value)).slice(0, 20);
    if (json) {
      console.log(JSON.stringify(runsAnswer(name.value, latest, releasesOf(name.value)[0])));
      return 0;
    }
    latest.forEach((run) => {
      console.log([run.id, run.state.padEnd(8), (run.sha ?? "").slice(0, 12).padEnd(12), run.why.padEnd(8), run.what].join("  "));
    });
    return 0;
  },
  log: ([who, id]) => {
    const minted = mintOwner(who === "gc" || who === "renovate" ? `_${who}` : (who ?? ""));
    if (!minted.ok) return fail(minted.error);
    const given = id === undefined ? undefined : runId(id);
    const run = given === undefined ? runsOf(runs, minted.value)[0]?.id : given.ok ? given.value : undefined;
    const text = run === undefined ? undefined : log(runs, minted.value, run);
    if (text === undefined) return fail(`no such run of ${minted.value}`);
    process.stdout.write(text);
    return 0;
  },
  deploy: ([app, ref], json) => start({ app, ref: ref ?? "", why: "deploy" }, json),
  rollback: ([app, commit], json) => {
    const name = appName(app ?? "");
    if (!name.ok) return fail(name.error);
    const all = releasesOf(name.value);
    const [live, ...earlier] = all;
    if (live === undefined) return fail(`${name.value} has not been deployed yet`);
    if (commit === undefined && json) {
      console.log(JSON.stringify(releasesAnswer(name.value, all)));
      return earlier.length === 0 ? 1 : 0;
    }
    if (commit === undefined) {
      console.log(`${name.value} runs ${live.sha} (since ${live.time}). Earlier releases:`);
      earlier.forEach((release) => {
        console.log(`  ${release.sha}  ${release.time}`);
      });
      return earlier.length === 0 ? fail("nothing to roll back to") : 0;
    }
    const target = earlier.find((release) => release.sha.startsWith(commit));
    if (target === undefined || commit.length < 7) return fail(`${commit} is not an earlier release of ${name.value}`);
    return start({ app: name.value, ref: target.sha, why: "rollback" }, json);
  },
  job: async ([job, flag]) => {
    const posted = await post("/job", { job, dryRun: flag === "--dry-run" });
    if (posted.run !== undefined) console.log(`${String(job)}: run ${posted.run.id}; kayra app logs <server> ${String(job)} shows its log`);
    return posted.code;
  },
};

export const ctl = async (args: readonly string[]) => {
  const [name, ...rest] = args;
  const command = name === undefined ? undefined : commands[name];
  return command === undefined
    ? fail(`usage: ctl ${Object.keys(commands).join("|")} … [--json]`)
    : command(
        rest.filter((word) => word !== "--json"),
        rest.includes("--json"),
      );
};
