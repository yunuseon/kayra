import type { Deployed, ReleasesAnswer, RunAnswer, RunsAnswer } from "../../deployer/answers.ts";
import type { DeployerAnswer } from "../plan/model.ts";
import { accent, active, bad, muted, ok, strong, warn, type Line, type Span, type Text } from "../text/spans.ts";
import { ago, duration, table } from "./text.ts";
import { parsed, releasesSchema, runsSchema } from "../ctl/answers.ts";

/** Lines as printing them one by one gives the text back: newline-ended, as a ctl writes. */
const linesOf = (text: string): readonly string[] => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

const short = (sha: string): string => sha.slice(0, 7);

const since = (time: string, now: number): string => ago(now - Date.parse(time));

const heading = (view: DeployerAnswer, ...more: readonly Span[]): Line => [strong(view.app), muted(` on ${view.server}`), ...more];

const live = (release: Deployed | undefined, now: number): readonly Span[] =>
  release === undefined
    ? [muted(" · not deployed yet")]
    : [muted(" · live "), accent(short(release.sha)), muted(` since ${since(release.time, now)}`)];

const hint = (command: string, what: string): Line => ["  ", active("→"), " ", strong(command), muted(` ${what}`)];

const states: Readonly<Record<RunAnswer["state"], Line>> = {
  success: [ok("✓ success")],
  failure: [bad("✗ failure")],
  running: [active("◆ running")],
};

const took = (run: RunAnswer, now: number): Line =>
  run.finished === undefined
    ? [active(`${duration(now - Date.parse(run.started))}…`)]
    : [duration(Date.parse(run.finished) - Date.parse(run.started))];

const commit = (run: RunAnswer, release: Deployed | undefined): Line => {
  if (run.sha === undefined) return [muted("—")];
  return run.sha === release?.sha ? [accent(short(run.sha))] : [short(run.sha)];
};

/** `kayra app runs`: what runs now, then a table of the newest runs. */
export const runsView = (view: DeployerAnswer, answer: RunsAnswer, now: number): readonly Line[] => {
  const rows = table([
    ["STATE", "COMMIT", "WHY", "WHEN", "TOOK", "RUN"].map((title) => [muted(title)]),
    ...answer.runs.map((run) => [states[run.state], commit(run, answer.live), [run.why], [since(run.started, now)], took(run, now), [muted(run.id)]]),
  ]);
  return [
    heading(view, ...live(answer.live, now)),
    [],
    ...(answer.runs.length === 0
      ? [["  ", muted("no runs yet")]]
      : [...rows.map((row): Line => ["  ", ...row]), [], hint(`kayra app logs ${view.server} ${view.app} [RUN]`, "shows a run's log, the newest by default")]),
  ];
};

/** `kayra app rollback` without a commit: every release, the live one marked, and how to go back to one. */
export const releasesView = (view: DeployerAnswer, answer: ReleasesAnswer, now: number): readonly Line[] => {
  const earlier = answer.releases.find((release) => !release.live);
  const rows = table([
    [[muted("  COMMIT")], [muted("DEPLOYED")]],
    ...answer.releases.map((release) => [
      release.live ? [ok("●"), " ", accent(short(release.sha))] : ["  ", short(release.sha)],
      [since(release.time, now)],
      release.live ? [ok("live")] : [],
    ]),
  ]);
  const count = answer.releases.length;
  return [
    heading(view, muted(` · ${String(count)} release${count === 1 ? "" : "s"}`)),
    [],
    ...rows.map((row): Line => ["  ", ...row]),
    [],
    earlier === undefined
      ? ["  ", muted("nothing earlier to roll back to")]
      : hint(`kayra app rollback ${view.server} ${view.app} ${short(earlier.sha)}`, "deploys that one again"),
  ];
};

const errors = /\b(error|fatal|failed|failure|panic|refused|denied|unhealthy)\b/i;

const warnings = /\b(warn|warning|deprecated)\b/i;

/** The deployer's time, before each line it logs. */
const stamped = /^(\d{2}:\d{2}:\d{2} )(.*)$/s;

const logLine = (line: string): Line => {
  const [, time = "", text = line] = stamped.exec(line) ?? [];
  const tone = errors.test(text) ? bad : warnings.test(text) ? warn : text.startsWith("── ") ? strong : text.startsWith("Deployed ") ? ok : undefined;
  return [...(time === "" ? [] : [muted(time)]), tone === undefined ? text : tone(text)];
};

/** `kayra app logs`: the log as it is, its errors and warnings marked; uncoloured, the same bytes. */
export const logView = (log: string): readonly Line[] => linesOf(log).map(logLine);

/** A deployer's answer as its view draws it, or as it came if it is not what the view reads (an older ctl). */
export const draw = (view: DeployerAnswer, answer: string, now: number): readonly Text[] => {
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
export const drawnAs = (view: DeployerAnswer): string => {
  switch (view.view) {
    case "runs":
      return "its answer drawn as a table of runs";
    case "releases":
      return "its answer drawn as the releases, the live one marked";
    case "log":
      return "the log as it is, errors and warnings marked on a terminal";
  }
};
