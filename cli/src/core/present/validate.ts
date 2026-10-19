import { active, bad, muted, ok, strong, type Line, type Span } from "../text/spans.ts";
import { count, overall, type Report, type Verdict } from "../validation/findings.ts";

const marks: Readonly<Record<Verdict, Span>> = { problem: bad("✗"), unchecked: muted("·"), passed: ok("✓") };

const tally = (reports: readonly Report[]): { readonly problems: number; readonly unchecked: number } => {
  const all = reports.flatMap((report) => report.findings);
  return {
    problems: all.filter((each) => each.result === "problem").length,
    unchecked: all.filter((each) => each.result === "unchecked").length,
  };
};

/** "✗ 3 servers · 1 problem · 2 not checked" */
export const summary = (reports: readonly Report[]): Line => {
  const { problems, unchecked: notChecked } = tally(reports);
  return [
    marks[overall(reports.flatMap((report) => report.findings))],
    " ",
    count(reports.length, "server"),
    muted(" · "),
    problems === 0 ? ok("no problems") : bad(count(problems, "problem")),
    ...(notChecked === 0 ? [] : [muted(" · "), `${String(notChecked)} not checked`]),
  ];
};

/** Each server with its mark, its findings under it with what to do about them, then the summary. */
export const validateView = (reports: readonly Report[]): readonly Line[] => {
  const names = Math.max(0, ...reports.map((report) => report.server.name.length));
  return [
    ...reports.flatMap((report): readonly Line[] => [
      [marks[overall(report.findings)], " ", strong(report.server.name.padEnd(names)), muted(`  ${report.server.kind} on ${report.server.target}`)],
      ...report.findings.flatMap((each): readonly Line[] => [
        ["    ", marks[each.result], " ", each.result === "passed" ? muted(each.text) : each.text],
        ...(each.hint === undefined ? [] : [["      ", active("→"), " ", each.hint]]),
      ]),
      [],
    ]),
    summary(reports),
  ];
};

/** `kayra validate --json`: the shape cli.md documents. */
export const validateJson = (reports: readonly Report[]) => ({
  result: overall(reports.flatMap((report) => report.findings)),
  ...tally(reports),
  servers: reports.map((report) => ({
    name: report.server.name,
    kind: report.server.kind,
    target: report.server.target,
    result: overall(report.findings),
    findings: report.findings.map((each) => ({ result: each.result, text: each.text, hint: each.hint ?? null })),
  })),
});
