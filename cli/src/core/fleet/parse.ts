import { parseDocument } from "yaml";
import { absolutePath, appName, domain, host, sshDefaultPort, keyFile, port, remotePath, repoPath, repoUrl, sshUser, vaultPasswordFile, type Domain } from "./brand.ts";
import { all, err, map, mapError, ok, type Result } from "../../result.ts";
import { serverKinds, serverSchema, varsSchema } from "./settings.ts";
import { checkSettings, checkShape, knownSettings } from "./shape.ts";
import { serverTargets, type App, type Inventory, type Server, type ServerFiles, type ServerTarget, type Vault } from "./model.ts";

type Fields = Readonly<Record<string, unknown>>;

export const mapping = (value: unknown): Fields | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;

/** YAML text as a value; a syntax error is a value too, not an exception. */
export const yamlOf = (text: string): Result<unknown, string> => {
  const document = parseDocument(text);
  const problem = document.errors.at(0);
  return problem === undefined ? ok(document.toJS()) : err(`is not valid YAML: ${problem.message.split("\n")[0] ?? ""}`);
};

/** YAML text as a mapping; empty for an empty file. */
export const fields = (text: string): Result<Fields, string> => {
  const parsed = yamlOf(text);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (value === null || value === undefined) return ok({});
  const result = mapping(value);
  return result === undefined ? err("is not a YAML mapping") : ok(result);
};

export const isVaulted = (text: string): boolean => text.startsWith("$ANSIBLE_VAULT");

const oneOf = <T extends string>(allowed: readonly T[], value: unknown, field: string): Result<T, string> => {
  const match = allowed.find((candidate) => candidate === value);
  return match === undefined
    ? err(`${field} must be ${allowed.join(", ")}, not '${String(value)}'`)
    : ok(match);
};

const vault = (descriptor: Fields): Result<Vault, string> => {
  const file = descriptor["vault_password_file"];
  if (descriptor["vault"] !== true) return ok({ kind: "none" });
  if (file === undefined) return ok({ kind: "ask" });
  return typeof file === "string"
    ? map(absolutePath(file), (path) => ({ kind: "file", file: vaultPasswordFile(path) }))
    : err("vault_password_file must be a path");
};

/**
 * Apps live in their own repo: the builder clones it over HTTPS, and the app
 * root stays inside it. A multipass server, a test machine by definition, may
 * clone over plain HTTP too: the upgrade lab serves its fixture app that way.
 */
const app = (target: ServerTarget) => (value: unknown): Result<App, string> => {
  const entry = mapping(value);
  if (entry === undefined) return err("an app must be a mapping");
  const name = typeof entry["name"] === "string" ? appName(entry["name"]) : err("an app needs a name");
  if (!name.ok) return name;
  const declared = entry["repo"];
  const repo = typeof declared === "string" ? repoUrl(declared, target === "multipass" ? ["https://", "http://"] : ["https://"]) : undefined;
  if (repo?.ok !== true) return err(`app ${name.value}: repo must be an https:// URL${target === "multipass" ? " (or http:// on multipass)" : ""}`);
  const within = entry["path"] ?? ".";
  const path = typeof within === "string" ? repoPath(within) : undefined;
  if (path?.ok !== true) return err(`app ${name.value}: path must stay inside its repo`);
  return ok({ name: name.value, repo: repo.value, path: path.value, entry });
};

const inventoryField = (inventory: string, key: string): string =>
  new RegExp(`${key}=([^ \\n]*)`).exec(inventory)?.[1] ?? "";

/** A field the inventory may leave out: undefined where it does. */
const optional = <T>(value: string, mint: (value: string) => Result<T, string>): Result<T | undefined, string> =>
  value === "" ? ok(undefined) : mint(value);

const inventoryOf = (text: string): Result<Inventory, string> => {
  const fields = [
    optional(inventoryField(text, "ansible_host"), host),
    port(inventoryField(text, "ansible_port") || sshDefaultPort),
    optional(inventoryField(text, "ansible_user"), sshUser),
    optional(inventoryField(text, "ansible_ssh_private_key_file"), keyFile),
  ] as const;
  const [address, sshPort, user, key] = fields;
  if (!address.ok) return mapError(address, (why) => `inventory.ini: ansible_host ${why}`);
  if (!sshPort.ok) return mapError(sshPort, (why) => `inventory.ini: ansible_port ${why}`);
  if (!user.ok) return mapError(user, (why) => `inventory.ini: ansible_user ${why}`);
  if (!key.ok) return mapError(key, (why) => `inventory.ini: ansible_ssh_private_key_file ${why}`);
  return ok({ host: address.value, port: sshPort.value, user: user.value, key: key.value });
};

const stackHosts = (stacks: readonly string[], serverDomain: Domain): readonly string[] =>
  stacks
    .flatMap((compose) => [...compose.matchAll(/Host\(`([^`]*)`\)/g)].map((match) => match[1] ?? ""))
    .map((host) => (host.endsWith(`.${serverDomain}`) ? host.slice(0, -serverDomain.length - 1) : host));

/** An app's config is plaintext, to be read and diffed; its secrets are vaulted wherever secrets.yml is. */
const appValuesProblem = (
  appValues: ServerFiles["appValues"],
  secretsMustBeVaulted: boolean,
): string | undefined =>
  appValues
    .map(({ file, text }) =>
      file.endsWith(".secrets.yml")
        ? secretsMustBeVaulted && !isVaulted(text)
          ? `apps/${file} must be vault-encrypted`
          : undefined
        : isVaulted(text)
          ? `apps/${file} is vault-encrypted; it holds config only — secrets go in apps/${file.replace(/\.yml$/, ".secrets.yml")}`
          : undefined,
    )
    .find((problem) => problem !== undefined);

/** What every command may rely on, checked for every server whenever the fleet loads. */
export const parseServer = (files: ServerFiles): Result<Server, string> => {
  const descriptor = fields(files.descriptor);
  if (!descriptor.ok) return descriptor;
  const kind = oneOf(serverKinds, descriptor.value["kind"] ?? "platform", "kind");
  if (!kind.ok) return kind;
  const target = oneOf(serverTargets, descriptor.value["target"], "target");
  if (!target.ok) return target;
  const declared = descriptor.value["domain"];
  const serverDomain = typeof declared === "string" ? domain(declared) : err("domain is required");
  if (!serverDomain.ok) return serverDomain;
  const serverVault = vault(descriptor.value);
  if (!serverVault.ok) return serverVault;
  const declaredApps: unknown = descriptor.value["apps"] ?? [];
  if (!Array.isArray(declaredApps)) return err("apps must be a list");
  if (kind.value !== "platform" && declaredApps.length > 0) return err("apps run on platform servers only");
  const apps = all(declaredApps.map(app(target.value)));
  if (!apps.ok) return apps;
  const shape = checkShape("server.yml", descriptor.value, serverSchema);
  if (!shape.ok) return shape;
  if (target.value === "home" && files.inventory === undefined)
    return err("target home needs a hand-written inventory.ini next to it");
  if (target.value !== "home" && !files.hasTerraform) return err("no terraform/ next to it");
  if (files.vars === undefined) return err("no vars.yml next to it");
  if (files.secrets === undefined) return err("no secrets.yml next to it");
  if (isVaulted(files.vars)) return err("vars.yml is vault-encrypted; it holds settings only — secrets go in secrets.yml");
  if (target.value !== "multipass" && serverVault.value.kind === "none")
    return err(`target ${target.value} requires vault: true`);
  if (target.value !== "multipass" && !isVaulted(files.secrets))
    return err(`target ${target.value} requires a vault-encrypted secrets.yml`);
  const appValues = appValuesProblem(files.appValues, target.value !== "multipass");
  if (appValues !== undefined) return err(appValues);
  const vars = fields(files.vars);
  if (!vars.ok) return err(`vars.yml ${vars.error}`);
  const varsChecked = checkSettings("vars.yml", vars.value, varsSchema(kind.value), knownSettings(kind.value));
  if (!varsChecked.ok) return varsChecked;
  const backup = mapping(vars.value["restic_backup"])?.["dir"];
  const backupDir = typeof backup === "string" ? remotePath(backup) : ok(undefined);
  if (!backupDir.ok) return err(`vars.yml: restic_backup.dir ${backupDir.error}`);
  const inventory = files.inventory === undefined ? ok(undefined) : inventoryOf(files.inventory);
  if (!inventory.ok) return inventory;
  return ok({
    name: files.name,
    dir: files.dir,
    kind: kind.value,
    target: target.value,
    domain: serverDomain.value,
    vault: serverVault.value,
    hasVaultedSecrets: isVaulted(files.secrets),
    apps: apps.value,
    hasTerraform: files.hasTerraform,
    buildsVm: target.value === "home" && vars.value["vm"] !== undefined,
    usesAcmeDns: typeof vars.value["acme_dns"] === "string" && vars.value["acme_dns"] !== "",
    inventory: inventory.value,
    backupDir: backupDir.value,
    stackHosts: stackHosts(files.stacks.flatMap((stack) => stack.compose ?? []), serverDomain.value),
    vars: vars.value,
    files: { vars: files.vars, secrets: files.secrets, stacks: files.stacks.map((stack) => stack.name), appValues: files.appValues },
  });
};
