import { overall, type Report, tally } from "../../core/validation/findings.ts";

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
} as const);
