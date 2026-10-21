import { join, relative } from "node:path";
import { textAt } from "../adapters/fs.ts";
import type { FleetRoot } from "../fleet/brand.ts";
import type { Facts, Recipients, Secrets } from "./findings.ts";
import { appSecretsIn, hostSecretsIn, isEncrypted, secretsShape } from "../fleet/secrets.ts";
import { fields, mapping } from "../../lib/yaml.ts";
import type { Server } from "../fleet/model.ts";
import { typed } from "../../lib/typed.ts";

/** YAML as validate reads it: what it cannot read holds no values. */
const valuesOf = (text: string | undefined) => {
  const parsed = text === undefined ? undefined : fields(text);
  return parsed?.ok === true ? parsed.value : typed<Readonly<Record<string, unknown>>>({});
};

/** secrets.yml without its key: SOPS leaves the keys, and each value's type. */
const secretsOf = (text: string) => {
  const shape = secretsShape(text);
  return shape.ok ? typed<Secrets>({ kind: "readable", values: shape.value }) : typed<Secrets>({ kind: "locked", reason: shape.error });
};

const ageRecipients = (value: unknown) =>
  Object.freeze((typeof value === "string" ? value.split(",") : []).map((each) => each.trim()).filter((each) => each !== "").toSorted());

/**
 * Whom secrets.yml is encrypted to, and whom .sops.yaml's first rule matching
 * its path says it should be: they drift when a key is added to .sops.yaml
 * and `sops updatekeys` is not run.
 */
const recipientsOf = (root: FleetRoot, server: Server, text: string) => {
  if (!isEncrypted(text)) return undefined;
  const path = relative(root, server.secrets.file);
  const rules: unknown = mapping(valuesOf(textAt(join(root, ".sops.yaml"))))?.["creation_rules"];
  const rule = (Array.isArray(rules) ? rules : [])
    .map((each) => mapping(each) ?? {})
    .find((each) => typeof each["path_regex"] !== "string" || new RegExp(each["path_regex"]).test(path));
  const metadata: unknown = mapping(valuesOf(text)["sops"])?.["age"];
  const actual = Object.freeze((Array.isArray(metadata) ? metadata : []).map((each) => mapping(each)?.["recipient"]).filter((each): each is string => typeof each === "string").toSorted());
  return typed<Recipients>({ wanted: rule === undefined ? undefined : ageRecipients(rule["age"]), actual });
};

/**
 * What validate needs of a server: its files as the fleet loaded them,
 * secrets.yml's keys (no key needed), and each app's app.yml from the
 * fleet's clone (.cache/apps).
 */
export const gather = (root: FleetRoot, server: Server) => {
  const appText = (file: string) => server.files.appValues.find((each) => each.file === file)?.text;
  const secrets = secretsOf(server.files.secrets);
  const all = secrets.kind === "readable" ? secrets.values : {};
  return Promise.resolve(typed<Facts>({
    server,
    vars: server.vars,
    varsText: server.files.vars,
    secrets: secrets.kind === "readable" ? { kind: "readable", values: hostSecretsIn(all) } : secrets,
    recipients: recipientsOf(root, server, server.files.secrets),
    stackDirs: server.files.stacks,
    appConfig: Object.fromEntries(server.apps.map((app) => [app.name, valuesOf(appText(`${app.name}.yml`))] as const)),
    appSecrets: Object.fromEntries(server.apps.map((app) => [app.name, secrets.kind === "readable" ? typed<Secrets>({ kind: "readable", values: appSecretsIn(all, app.name) }) : secrets] as const)),
    terraform: mapping(all["terraform"]) ?? {},
    manifests: Object.fromEntries(
      server.apps.flatMap((app) => {
        const manifest = textAt(join(root, ".cache", "apps", app.name, app.path, "app.yml"));
        return manifest === undefined ? Object.freeze([]) : Object.freeze([[app.name, valuesOf(manifest)] as const]);
      }),
    ),
  }));
};
