import { appManifestSchema, secretsSchema, settings, type ServerKind } from "../fleet/settings.ts";
import type { Server } from "../fleet/model.ts";
import { closest } from "../../lib/closest.ts";
import { count } from "../text/plural.ts";
import { mapping as fields } from "../../lib/yaml.ts";
import { subdomain } from "../fleet/brand.ts";
import { typed } from "../../lib/typed.ts";

/** A secrets file as validate could read it; a missing one holds no values. */
export type Secrets =
  | { readonly kind: "readable"; readonly values: Readonly<Record<string, unknown>> }
  | { readonly kind: "locked"; readonly reason: string; readonly hint?: string };

/** Whom secrets.yml is encrypted to, and whom .sops.yaml wants (undefined where no rule matches it). */
export type Recipients = { readonly wanted: readonly string[] | undefined; readonly actual: readonly string[] };

/** What validate reads of one server, beyond what loading the fleet already checked. */
export type Facts = {
  readonly server: Server;
  readonly vars: Readonly<Record<string, unknown>>;
  /** vars.yml as written, to see which secrets it uses. */
  readonly varsText: string;
  /** secrets.yml's own (the host's) secrets, each value a stand-in of its type. */
  readonly secrets: Secrets;
  /** undefined where secrets.yml is plaintext (a multipass server's). */
  readonly recipients: Recipients | undefined;
  /** Folders under stacks/. */
  readonly stackDirs: readonly string[];
  /** apps/<app>.yml (config), parsed. */
  readonly appConfig: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** secrets.yml's app_secrets, by app. */
  readonly appSecrets: Readonly<Record<string, Secrets>>;
  /** secrets.yml's terraform: OpenTofu's variables. */
  readonly terraform: Readonly<Record<string, unknown>>;
  /** Each app's app.yml from the fleet's clone (.cache/apps), where cloned. */
  readonly manifests: Readonly<Record<string, unknown>>;
};

/** How a check went: it found a problem, could not look, or holds. */
export const verdicts = ["problem", "unchecked", "passed"] as const;
export type Verdict = (typeof verdicts)[number];

/** `hint`: what to do about it. */
export type Finding = { readonly result: Verdict; readonly text: string; readonly hint?: string };

const finding = (result: Verdict, text: string, hint?: string) => typed<Finding>({ result, text, ...(hint === undefined ? {} : { hint }) });

const problem = (text: string, hint?: string) => finding("problem", text, hint);

const unchecked = (text: string, hint?: string) => finding("unchecked", text, hint);

const passed = (text: string) => finding("passed", text);

/** A check's findings, or one line saying it holds when it found nothing to say. */
const holds = (found: readonly Finding[], text: string) => (found.length === 0 ? typed<readonly Finding[]>([passed(text)]) : found);


const mapping = (value: unknown) => fields(value) ?? {};

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : typed<readonly string[]>([]);

const secretSettingNames = (kind: ServerKind) =>
  Object.freeze(settings.filter((each) => each.secret && each.kinds.includes(kind)).map((each) => each.name));

/** secrets.yml: known secrets typed; anything else must be a helper vars.yml uses. */
const secretsFindings = (facts: Facts) => {
  if (facts.secrets.kind === "locked") return typed<readonly Finding[]>([unchecked(`secrets.yml not checked: ${facts.secrets.reason}`, facts.secrets.hint)]);
  const values = facts.secrets.values;
  const checked = secretsSchema(facts.server.kind).safeParse(values);
  const typeProblems = checked.success
    ? []
    : checked.error.issues.slice(0, 1).map((issue) => problem(`secrets.yml: ${issue.path.join(".")}: ${issue.message}`));
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

/** secrets.yml is encrypted to exactly the age recipients .sops.yaml names for it. */
const recipientFindings = (facts: Facts) => {
  const recipients = facts.recipients;
  if (recipients === undefined) return typed<readonly Finding[]>([]);
  if (recipients.wanted === undefined)
    return typed<readonly Finding[]>([problem("secrets.yml: no creation rule in .sops.yaml matches it", "add a rule whose path_regex matches it, with its age recipients")]);
  const missing = recipients.wanted.filter((each) => !recipients.actual.includes(each));
  const extra = recipients.actual.filter((each) => !recipients.wanted?.includes(each));
  const fix = `sops updatekeys servers/${facts.server.name}/secrets.yml`;
  return holds(
    [
      ...missing.map((each) => problem(`secrets.yml is not encrypted to ${each}, which .sops.yaml names`, fix)),
      ...extra.map((each) => problem(`secrets.yml is encrypted to ${each}, which .sops.yaml no longer names`, `${fix}, then rotate what that key could read`)),
    ],
    `secrets.yml: encrypted to the ${count(recipients.wanted.length, "recipient")} .sops.yaml names`,
  );
};

/** secrets.yml's terraform: OpenTofu's variables are flat values. */
const terraformFindings = (facts: Facts) =>
  typed<readonly Finding[]>(
    Object.entries(facts.terraform)
      .filter(([, value]) => !["string", "number", "boolean"].includes(typeof value))
      .map(([key]) => problem(`secrets.yml: terraform.${key} must be a string, number or boolean`)),
  );

/** compose_stacks.stacks and stacks/ name the same stacks. */
const stackFindings = (facts: Facts) => {
  const listed = strings(mapping(facts.vars["compose_stacks"])["stacks"]);
  if (listed.length === 0 && facts.stackDirs.length === 0) return typed<readonly Finding[]>([]);
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
const routeFindings = (facts: Facts) => {
  const routes: readonly unknown[] = Array.isArray(facts.vars["edge_routes"]) ? facts.vars["edge_routes"] : [];
  if (routes.length === 0) return typed<readonly Finding[]>([]);
  return holds(
    routes.flatMap((route, index) => {
      const fields = mapping(route);
      const upstream = fields["upstream"];
      return Object.freeze([
        ...strings(fields["subdomains"])
          .filter((sub) => !subdomain(sub).ok)
          .map((sub) => problem(`edge_routes[${String(index)}]: '${sub}' is not a subdomain`, "lowercase letters, digits and dashes")),
        ...(typeof upstream === "string" && /^[^\s:]+:\d+$/.test(upstream)
          ? []
          : [problem(`edge_routes[${String(index)}]: upstream must be host:port`, "a host and its port, e.g. 192.168.1.10:8080")]),
      ]);
    }),
    `edge_routes: ${count(routes.length, "route")}, each with subdomains and a host:port upstream`,
  );
};

/** apex_redirect: the bare domain redirects to a host one of the server's apps serves. */
const apexFindings = (facts: Facts) => {
  const target = facts.vars["apex_redirect"];
  if (typeof target !== "string" || target === "") return typed<readonly Finding[]>([]);
  const hosts = facts.server.apps.flatMap((app) => {
    const parsed = appManifestSchema.safeParse(facts.manifests[app.name]);
    return typed<readonly string[]>(parsed.success ? (parsed.data.routes ?? []).map((route) => String(route.host)) : []);
  });
  const domain = facts.server.domain;
  if (hosts.includes(target)) return typed<readonly Finding[]>([passed(`apex_redirect: ${domain} redirects to ${target}.${domain}, which app routes serve`)]);
  if (facts.server.apps.some((app) => facts.manifests[app.name] === undefined))
    return typed<readonly Finding[]>([unchecked(`apex_redirect not checked: not every app is cloned yet`, `kayra apps ${facts.server.name} clones them`)]);
  return typed<readonly Finding[]>([
    problem(`apex_redirect: no app routes ${target}.${domain}, so ${domain} would redirect to nothing`, "name a route host of one of the server's apps"),
  ]);
};

/** Each app's contract against the fleet's values for it. */
const appFindings = (facts: Facts) =>
  Object.freeze(facts.server.apps.flatMap((app) => {
    const manifest: unknown = facts.manifests[app.name];
    if (manifest === undefined) return typed<readonly Finding[]>([unchecked(`app ${app.name} not checked: not cloned yet`, `kayra apps ${facts.server.name} clones it`)]);
    const parsed = appManifestSchema.safeParse(manifest);
    if (!parsed.success) return typed<readonly Finding[]>([problem(`app ${app.name}: its app.yml: ${parsed.error.issues.at(0)?.message ?? "invalid"}`)]);
    if (parsed.data.name !== app.name)
      return typed<readonly Finding[]>([problem(`app ${app.name}: its app.yml says name ${parsed.data.name}`, "server.yml and app.yml must name it alike")]);
    const configKeys = parsed.data.config ?? [];
    const secretKeys = parsed.data.secrets ?? [];
    const config = facts.appConfig[app.name] ?? {};
    const valuesFile = `apps/${app.name}.yml`;
    const secretsFile = "secrets.yml";
    const missingConfig = configKeys
      .filter((key) => !(key in config))
      .map((key) => problem(`${valuesFile}: no value for ${key}, which app.yml asks for`, `add ${key}: … to servers/${facts.server.name}/${valuesFile}`));
    const secrets = facts.appSecrets[app.name] ?? { kind: "readable", values: {} };
    const edit = `kayra app secret generate ${facts.server.name} ${app.name}`;
    const missingSecrets =
      secrets.kind === "locked"
        ? secretKeys.length === 0
          ? []
          : [unchecked(`${secretsFile} not checked: ${secrets.reason}`, secrets.hint)]
        : secretKeys
            .filter((key) => !(key in secrets.values))
            .map((key) => problem(`${secretsFile}: no app_secrets.${app.name}.${key}, which app.yml asks for`, `${edit} ${key} (or app secret import)`));
    return holds(
      [...missingConfig, ...missingSecrets],
      `app ${app.name}: ${count(configKeys.length, "config value")} and ${count(secretKeys.length, "secret")}, as its app.yml asks`,
    );
  }));

const rank: Readonly<Record<Verdict, number>> = { problem: 0, unchecked: 1, passed: 2 };

/** Everything validate finds for one server: problems first, then what it could not check, then what holds. */
export const findings = (facts: Facts) =>
  Object.freeze([...secretsFindings(facts), ...recipientFindings(facts), ...terraformFindings(facts), ...stackFindings(facts), ...routeFindings(facts), ...apexFindings(facts), ...appFindings(facts)].toSorted(
    (a, b) => rank[a.result] - rank[b.result],
  ));

/** One server's findings. */
export type Report = { readonly server: Server; readonly findings: readonly Finding[] };

/** How a set of findings went as a whole: its worst. */
export const overall = (found: readonly Finding[]) =>
  verdicts.find((verdict) => found.some((each) => each.result === verdict)) ?? "passed";

/** How many problems, and how many checks could not look, across reports. */
export const tally = (reports: readonly Report[]) => {
  const all = reports.flatMap((report) => report.findings);
  return {
    problems: all.filter((each) => each.result === "problem").length,
    unchecked: all.filter((each) => each.result === "unchecked").length,
  } as const;
};
