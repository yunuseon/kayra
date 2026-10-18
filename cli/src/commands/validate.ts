import { appManifestSchema, secretsSchema, settings, type ServerKind } from "../settings.ts";
import type { Server } from "../fleet.ts";
import { active, bad, muted, ok, strong, type Line, type Span } from "../ui/line.ts";
import { closest } from "../validate.ts";

/** A secrets file as validate could read it; a missing one holds no values. */
export type Secrets =
  | { readonly kind: "readable"; readonly values: Readonly<Record<string, unknown>> }
  | { readonly kind: "locked"; readonly reason: string; readonly hint?: string };

/** What validate reads of one server, beyond what loading the fleet already checked. */
export type Facts = {
  readonly server: Server;
  readonly vars: Readonly<Record<string, unknown>>;
  /** vars.yml as written, to see which secrets it uses. */
  readonly varsText: string;
  readonly secrets: Secrets;
  /** Folders under stacks/. */
  readonly stackDirs: readonly string[];
  /** apps/<app>.yml (config), parsed. */
  readonly appConfig: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** apps/<app>.secrets.yml, where readable. */
  readonly appSecrets: Readonly<Record<string, Secrets>>;
  /** Each app's app.yml from the fleet's clone (.cache/apps), where cloned. */
  readonly manifests: Readonly<Record<string, unknown>>;
};

/** How a check went: it found a problem, could not look, or holds. */
export type Verdict = "problem" | "unchecked" | "passed";

/** `hint`: what to do about it. */
export type Finding = { readonly result: Verdict; readonly text: string; readonly hint?: string };

const finding = (result: Verdict, text: string, hint?: string): Finding => ({ result, text, ...(hint === undefined ? {} : { hint }) });
const problem = (text: string, hint?: string): Finding => finding("problem", text, hint);
const unchecked = (text: string, hint?: string): Finding => finding("unchecked", text, hint);
const passed = (text: string): Finding => finding("passed", text);

/** A check's findings, or one line saying it holds when it found nothing to say. */
const holds = (found: readonly Finding[], text: string): readonly Finding[] => (found.length === 0 ? [passed(text)] : found);

const count = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? "" : "s"}`;

const mapping = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

const secretSettingNames = (kind: ServerKind): readonly string[] =>
  settings.filter((each) => each.secret && each.kinds.includes(kind)).map((each) => each.name);

/** secrets.yml: known secrets typed; anything else must be a helper vars.yml uses. */
const secretsFindings = (facts: Facts): readonly Finding[] => {
  if (facts.secrets.kind === "locked") return [unchecked(`secrets.yml not checked: ${facts.secrets.reason}`, facts.secrets.hint)];
  const values = facts.secrets.values;
  const typed = secretsSchema(facts.server.kind).safeParse(values);
  const typeProblems = typed.success
    ? []
    : typed.error.issues.slice(0, 1).map((issue) => problem(`secrets.yml: ${issue.path.join(".")}: ${issue.message}`));
  const known = secretSettingNames(facts.server.kind);
  const unused = Object.keys(values)
    .filter((key) => !known.includes(key) && !key.startsWith("ansible_"))
    .filter((key) => !new RegExp(`\\b${key}\\b`).test(facts.varsText))
    .map((key) => {
      const meant = closest(key, known);
      return problem(
        `secrets.yml: '${key}' is no secret of ${/^[aeiou]/.test(facts.server.kind) ? "an" : "a"} ${facts.server.kind} server, and vars.yml does not use it`,
        meant === undefined ? "remove it, or use it in vars.yml" : `did you mean '${meant}'?`,
      );
    });
  return holds([...typeProblems, ...unused], `secrets.yml: ${count(Object.keys(values).length, "secret")}, each a setting or used by vars.yml`);
};

/** compose_stacks.stacks and stacks/ name the same stacks. */
const stackFindings = (facts: Facts): readonly Finding[] => {
  const listed = strings(mapping(facts.vars["compose_stacks"])["stacks"]);
  if (listed.length === 0 && facts.stackDirs.length === 0) return [];
  return holds(
    [
      ...listed
        .filter((name) => !facts.stackDirs.includes(name))
        .map((name) =>
          problem(`compose_stacks.stacks: '${name}' has no stacks/${name}/compose.yaml`, `add stacks/${name}/compose.yaml, or take '${name}' off the list`),
        ),
      ...facts.stackDirs
        .filter((name) => !listed.includes(name))
        .map((name) =>
          problem(`stacks/${name} is not in compose_stacks.stacks, so it never runs`, "list it in compose_stacks.stacks in vars.yml, or remove the folder"),
        ),
    ],
    `stacks: ${count(listed.length, "stack")}, each listed in compose_stacks.stacks and in stacks/`,
  );
};

/** edge_routes: subdomains and an upstream host:port. */
const routeFindings = (facts: Facts): readonly Finding[] => {
  const routes: readonly unknown[] = Array.isArray(facts.vars["edge_routes"]) ? facts.vars["edge_routes"] : [];
  if (routes.length === 0) return [];
  return holds(
    routes.flatMap((route, index) => {
      const fields = mapping(route);
      const upstream = fields["upstream"];
      return [
        ...strings(fields["subdomains"])
          .filter((sub) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sub))
          .map((sub) => problem(`edge_routes[${String(index)}]: '${sub}' is not a subdomain`, "lowercase letters, digits and dashes")),
        ...(typeof upstream === "string" && /^[^\s:]+:\d+$/.test(upstream)
          ? []
          : [problem(`edge_routes[${String(index)}]: upstream must be host:port`, "a host and its port, e.g. 192.168.1.10:8080")]),
      ];
    }),
    `edge_routes: ${count(routes.length, "route")}, each with subdomains and a host:port upstream`,
  );
};

/** Each app's contract against the fleet's values for it. */
const appFindings = (facts: Facts): readonly Finding[] =>
  facts.server.apps.flatMap((app): readonly Finding[] => {
    const manifest: unknown = facts.manifests[app.name];
    if (manifest === undefined) return [unchecked(`app ${app.name} not checked: not cloned yet`, `kayra apps ${facts.server.name} clones it`)];
    const parsed = appManifestSchema.safeParse(manifest);
    if (!parsed.success) return [problem(`app ${app.name}: its app.yml: ${parsed.error.issues.at(0)?.message ?? "invalid"}`)];
    if (parsed.data.name !== app.name)
      return [problem(`app ${app.name}: its app.yml says name ${parsed.data.name}`, "server.yml and app.yml must name it alike")];
    const configKeys = parsed.data.config ?? [];
    const secretKeys = parsed.data.secrets ?? [];
    const config = facts.appConfig[app.name] ?? {};
    const valuesFile = `apps/${app.name}.yml`;
    const secretsFile = `apps/${app.name}.secrets.yml`;
    const missingConfig = configKeys
      .filter((key) => !(key in config))
      .map((key) => problem(`${valuesFile}: no value for ${key}, which app.yml asks for`, `add ${key}: … to servers/${facts.server.name}/${valuesFile}`));
    const secrets = facts.appSecrets[app.name] ?? { kind: "readable", values: {} };
    const edit = facts.server.target === "multipass" ? "add it to" : "ansible-vault edit";
    const missingSecrets =
      secrets.kind === "locked"
        ? secretKeys.length === 0
          ? []
          : [unchecked(`${secretsFile} not checked: ${secrets.reason}`, secrets.hint)]
        : secretKeys
            .filter((key) => !(key in secrets.values))
            .map((key) => problem(`${secretsFile}: no value for ${key}, which app.yml asks for`, `${edit} servers/${facts.server.name}/${secretsFile}`));
    return holds(
      [...missingConfig, ...missingSecrets],
      `app ${app.name}: ${count(configKeys.length, "config value")} and ${count(secretKeys.length, "secret")}, as its app.yml asks`,
    );
  });

const rank: Readonly<Record<Verdict, number>> = { problem: 0, unchecked: 1, passed: 2 };

/** Everything validate finds for one server: problems first, then what it could not check, then what holds. */
export const findings = (facts: Facts): readonly Finding[] =>
  [...secretsFindings(facts), ...stackFindings(facts), ...routeFindings(facts), ...appFindings(facts)].toSorted(
    (a, b) => rank[a.result] - rank[b.result],
  );

/** One server's findings. */
export type Report = { readonly server: Server; readonly findings: readonly Finding[] };

/** How a set of findings went as a whole: its worst. */
export const overall = (found: readonly Finding[]): Verdict =>
  found.some((each) => each.result === "problem") ? "problem" : found.some((each) => each.result === "unchecked") ? "unchecked" : "passed";

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
