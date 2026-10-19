import { bad, muted, ok, pointing, strong, type Line, type Span } from "../../core/text/spans.ts";
import { count } from "../../core/text/plural.ts";
import { overall, type Report, tally, type Verdict } from "../../core/validation/findings.ts";

const marks: Readonly<Record<Verdict, Span>> = { problem: bad("✗"), unchecked: muted("·"), passed: ok("✓") };

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
        ...(each.hint === undefined ? [] : [pointing("      ", each.hint)]),
      ]),
      [],
    ]),
    summary(reports),
  ];
};
