import type { Deployed, ReleasesAnswer, RunAnswer, RunsAnswer } from "../../contracts/reporting.ts";
import type { DeployerAnswer } from "../../core/plan/model.ts";
import { accent, active, bad, type Line, muted, ok, pointing, type Span, strong, warn } from "../../core/text/spans.ts";
import { ago, table } from "./text.ts";
import { duration } from "../../core/text/time.ts";
import { parsed, releasesSchema, runsSchema } from "../../core/ctl/answers.ts";
import { count } from "../../core/text/plural.ts";
import { milliseconds } from "../../core/fleet/brand.ts";
import { typed } from "../../lib/typed.ts";

/** Lines as printing them one by one gives the text back: newline-ended, as a ctl writes. */
const linesOf = (text: string) => (text === "" ? typed<readonly string[]>([]) : text.replace(/\n$/, "").split("\n"));

const short = (sha: string) => sha.slice(0, 7);

const since = (time: string, now: number) => ago(milliseconds(now - Date.parse(time)));

const heading = (view: DeployerAnswer, ...more: readonly Span[]) => typed<Line>([strong(view.app), muted(` on ${view.server}`), ...more]);

const live = (release: Deployed | undefined, now: number) =>
  typed<readonly Span[]>(release === undefined ? [muted(" · not deployed yet")] : [muted(" · live "), accent(short(release.sha)), muted(` since ${since(release.time, now)}`)]);

const hint = (command: string, what: string) => pointing("  ", strong(command), muted(` ${what}`));

const states: Readonly<Record<RunAnswer["state"], Line>> = {
  success: [ok("✓ success")],
  failure: [bad("✗ failure")],
  running: [active("◆ running")],
  queued: [muted("… queued")],
  superseded: [muted("↷ superseded")],
};

/** Why the newest run failed, under the table: the first thing to know after a failed deploy. */
const newestError = (answer: RunsAnswer) => {
  const [newest] = answer.runs;
  return typed<readonly Line[]>(newest?.state === "failure" && newest.error !== undefined ? [["  ", bad(`✗ ${newest.error}`)], []] : []);
};

const took = (run: RunAnswer, now: number) =>
  typed<Line>(run.finished === undefined ? [active(`${duration(milliseconds(now - Date.parse(run.started)))}…`)] : [duration(milliseconds(Date.parse(run.finished) - Date.parse(run.started)))]);

const commit = (run: RunAnswer, release: Deployed | undefined) => {
  if (run.sha === undefined) return typed<Line>([muted("—")]);
  return typed<Line>(run.sha === release?.sha ? [accent(short(run.sha))] : [short(run.sha)]);
};

/** `kayra app runs`: what runs now, then a table of the newest runs. */
export const runsView = (view: DeployerAnswer, answer: RunsAnswer, now: number) => {
  const rows = table([
    ["STATE", "COMMIT", "WHY", "WHEN", "TOOK", "RUN"].map((title) => Object.freeze([muted(title)])),
    ...answer.runs.map((run) => Object.freeze([states[run.state], commit(run, answer.live), [run.why], [since(run.started, now)], took(run, now), [muted(run.id)]])),
  ]);
  return typed<readonly Line[]>([
    heading(view, ...live(answer.live, now)),
    [],
    ...(answer.runs.length === 0
      ? [["  ", muted("no runs yet")]]
      : [...rows.map((row) => typed<Line>(["  ", ...row])), [], ...newestError(answer), hint(`kayra app logs ${view.server} ${view.app} [RUN]`, "shows a run's log, the newest by default")]),
  ]);
};

/** `kayra app rollback` without a commit: every release, the live one marked, and how to go back to one. */
export const releasesView = (view: DeployerAnswer, answer: ReleasesAnswer, now: number) => {
  const earlier = answer.releases.find((release) => !release.live);
  const rows = table([
    [[muted("  COMMIT")], [muted("DEPLOYED")]],
    ...answer.releases.map((release) => typed<readonly Line[]>([
      release.live ? [ok("●"), " ", accent(short(release.sha))] : ["  ", short(release.sha)],
      [since(release.time, now)],
      release.live ? [ok("live")] : [],
    ])),
  ]);
  return typed<readonly Line[]>([
    heading(view, muted(` · ${count(answer.releases.length, "release")}`)),
    [],
    ...rows.map((row) => typed<Line>(["  ", ...row])),
    [],
    earlier === undefined
      ? ["  ", muted("nothing earlier to roll back to")]
      : hint(`kayra app rollback ${view.server} ${view.app} ${short(earlier.sha)}`, "deploys that one again"),
  ]);
};

const errors = /\b(error|fatal|failed|failure|panic|refused|denied|unhealthy)\b/i;

const warnings = /\b(warn|warning|deprecated)\b/i;

/** The deployer's time, before each line it logs. */
const stamped = /^(\d{2}:\d{2}:\d{2} )(.*)$/s;

const logLine = (line: string) => {
  const [, time = "", text = line] = stamped.exec(line) ?? [];
  const tone = errors.test(text) ? bad : warnings.test(text) ? warn : text.startsWith("── ") ? strong : text.startsWith("Deployed ") ? ok : undefined;
  return typed<Line>([...(time === "" ? [] : [muted(time)]), tone === undefined ? text : tone(text)]);
};

/** `kayra app logs`: the log as it is, its errors and warnings marked; uncoloured, the same bytes. */
export const logView = (log: string) => Object.freeze(linesOf(log).map(logLine));

/** A deployer's answer as its view draws it, or as it came if it is not what the view reads (an older ctl). */
export const draw = (view: DeployerAnswer, answer: string, now: number) => {
  switch (view.view) {
    case "runs": {
      const runs = parsed(runsSchema, answer);
      return runs === undefined ? linesOf(answer) : runsView(view, runs, now);
    }
    case "releases": {
      const releases = parsed(releasesSchema, answer);
      return releases === undefined ? linesOf(answer) : releasesView(view, releases, now);
    }
    case "log":
      return logView(answer);
  }
};

/** What --dry-run says about a drawn answer. */
export const drawnAs = (view: DeployerAnswer) => {
  switch (view.view) {
    case "runs":
      return "its answer drawn as a table of runs";
    case "releases":
      return "its answer drawn as the releases, the live one marked";
    case "log":
      return "the log as it is, errors and warnings marked on a terminal";
  }
};
