import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { releasesAnswer, runsAnswer } from "./answers.ts";
import { appOwner, appName, owner as mintOwner, runId } from "./brand.ts";
import { releases } from "./records.ts";
import { log, runsOf } from "./store.ts";

/**
 * The operator's side, run inside the deployer container by `kayra app …` and
 * `kayra job …` over SSH. Reads runs/ and releases/ directly; anything that
 * starts a run goes through the daemon's control port, so the queue stays the
 * only place runs begin. `--json` makes `runs` and rollback's list answer as
 * data (answers.ts), which kayra draws.
 */
const platformDir = process.env["PLATFORM_DIR"] ?? "/opt/platform";
const runs = join(platformDir, "runs");

const fail = (message: string): number => {
  console.error(message);
  return 1;
};

const post = async (path: string, payload: object): Promise<number> => {
  const response = await fetch(`http://127.0.0.1:8091${path}`, { method: "POST", body: JSON.stringify(payload) }).catch(() => undefined);
  if (response === undefined) return fail("the deployer is not running");
  process.stdout.write(await response.text());
  return response.ok ? 0 : 1;
};

const releasesOf = (app: string): ReturnType<typeof releases> => {
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
  deploy: ([app, ref]) => post("/deploy", { app, ref: ref ?? "", why: "deploy" }),
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
    return post("/deploy", { app: name.value, ref: target.sha, why: "rollback" });
  },
  job: ([job, flag]) => post("/job", { job, dryRun: flag === "--dry-run" }),
};

export const ctl = async (args: readonly string[]): Promise<number> => {
  const [name, ...rest] = args;
  const command = name === undefined ? undefined : commands[name];
  return command === undefined
    ? fail(`usage: ctl ${Object.keys(commands).join("|")} … [--json]`)
    : command(
        rest.filter((word) => word !== "--json"),
        rest.includes("--json"),
      );
};
