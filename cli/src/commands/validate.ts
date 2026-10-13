import { appManifestSchema, secretsSchema, settings, type ServerKind } from "../settings.ts";
import type { Server } from "../fleet.ts";

/** A secrets file as validate could read it. */
export type Secrets =
  | { readonly kind: "readable"; readonly values: Readonly<Record<string, unknown>> }
  | { readonly kind: "locked"; readonly reason: string };

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

export type Finding = { readonly problem: boolean; readonly text: string };

const problem = (text: string): Finding => ({ problem: true, text });
const skipped = (text: string): Finding => ({ problem: false, text });

const mapping = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

const secretSettingNames = (kind: ServerKind): readonly string[] =>
  settings.filter((each) => each.secret && each.kinds.includes(kind)).map((each) => each.name);

/** secrets.yml: known secrets typed; anything else must be a helper vars.yml uses. */
const secretsFindings = (facts: Facts): readonly Finding[] => {
  if (facts.secrets.kind === "locked") return [skipped(`secrets.yml not checked: ${facts.secrets.reason}`)];
  const values = facts.secrets.values;
  const typed = secretsSchema(facts.server.kind).safeParse(values);
  const typeProblems = typed.success
    ? []
    : typed.error.issues.slice(0, 1).map((issue) => problem(`secrets.yml: ${issue.path.join(".")}: ${issue.message}`));
  const known = secretSettingNames(facts.server.kind);
  const unused = Object.keys(values)
    .filter((key) => !known.includes(key) && !key.startsWith("ansible_"))
    .filter((key) => !new RegExp(`\\b${key}\\b`).test(facts.varsText))
    .map((key) => problem(`secrets.yml: '${key}' is no secret of a ${facts.server.kind} server, and vars.yml does not use it`));
  return [...typeProblems, ...unused];
};

/** compose_stacks.stacks and stacks/ name the same stacks. */
const stackFindings = (facts: Facts): readonly Finding[] => {
  const listed = strings(mapping(facts.vars["compose_stacks"])["stacks"]);
  return [
    ...listed
      .filter((name) => !facts.stackDirs.includes(name))
      .map((name) => problem(`compose_stacks.stacks: '${name}' has no stacks/${name}/compose.yaml`)),
    ...facts.stackDirs
      .filter((name) => !listed.includes(name))
      .map((name) => problem(`stacks/${name} is not in compose_stacks.stacks, so it never runs`)),
  ];
};

/** edge_routes: subdomains and an upstream host:port. */
const routeFindings = (facts: Facts): readonly Finding[] => {
  const routes: readonly unknown[] = Array.isArray(facts.vars["edge_routes"]) ? facts.vars["edge_routes"] : [];
  return routes.flatMap((route, index) => {
    const fields = mapping(route);
    const upstream = fields["upstream"];
    return [
      ...strings(fields["subdomains"])
        .filter((sub) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sub))
        .map((sub) => problem(`edge_routes[${String(index)}]: '${sub}' is not a subdomain`)),
      ...(typeof upstream === "string" && /^[^\s:]+:\d+$/.test(upstream)
        ? []
        : [problem(`edge_routes[${String(index)}]: upstream must be host:port`)]),
    ];
  });
};

/** Each app's contract against the fleet's values for it. */
const appFindings = (facts: Facts): readonly Finding[] =>
  facts.server.apps.flatMap((app) => {
    const manifest: unknown = facts.manifests[app.name];
    if (manifest === undefined) return [skipped(`app ${app.name} not checked: not cloned yet (kayra apps clones it)`)];
    const parsed = appManifestSchema.safeParse(manifest);
    if (!parsed.success)
      return [problem(`app ${app.name}: its app.yml: ${parsed.error.issues.at(0)?.message ?? "invalid"}`)];
    if (parsed.data.name !== app.name) return [problem(`app ${app.name}: its app.yml says name ${parsed.data.name}`)];
    const config = facts.appConfig[app.name] ?? {};
    const missingConfig = (parsed.data.config ?? [])
      .filter((key) => !(key in config))
      .map((key) => problem(`apps/${app.name}.yml: no value for ${key}, which app.yml asks for`));
    const secrets = facts.appSecrets[app.name];
    const missingSecrets =
      secrets === undefined || secrets.kind === "locked"
        ? (parsed.data.secrets ?? []).length === 0
          ? []
          : [skipped(`apps/${app.name}.secrets.yml not checked: ${secrets?.reason ?? "missing"}`)]
        : (parsed.data.secrets ?? [])
            .filter((key) => !(key in secrets.values))
            .map((key) => problem(`apps/${app.name}.secrets.yml: no value for ${key}, which app.yml asks for`));
    return [...missingConfig, ...missingSecrets];
  });

/** Everything validate finds for one server, problems first. */
export const findings = (facts: Facts): readonly Finding[] =>
  [...secretsFindings(facts), ...stackFindings(facts), ...routeFindings(facts), ...appFindings(facts)].toSorted(
    (a, b) => Number(b.problem) - Number(a.problem),
  );

/** One server's report: a line saying whether it holds, then each finding. */
export const report = (name: string, found: readonly Finding[]): readonly string[] => {
  const problems = found.filter((each) => each.problem);
  return [
    `${problems.length === 0 ? "ok  " : "FAIL"} ${name}`,
    ...found.map((each) => `     ${each.problem ? "✗" : "·"} ${each.text}`),
  ];
};
