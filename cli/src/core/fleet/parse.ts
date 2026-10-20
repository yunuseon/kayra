import type { z } from "zod";
import { absolutePath, host, sshDefaultPort, keyFile, port, remotePath, sshUser, vaultPasswordFile, type Domain } from "./brand.ts";
import { err, flatMap, map, ok, type Result } from "../../lib/result.ts";
import { serverSchema, varsSchema } from "./settings.ts";
import { checkSettings, knownSettings } from "./shape.ts";
import type { App, Inventory, Server, ServerFiles, Vault } from "./model.ts";
import { typed } from "../../lib/typed.ts";
import { fields, mapping, type Fields } from "../../lib/yaml.ts";

export const isVaulted = (text: string) => text.startsWith("$ANSIBLE_VAULT");

const vault = (descriptor: z.output<typeof serverSchema>) => {
  const file = descriptor.vault_password_file;
  if (!descriptor.vault) return ok<Vault>({ kind: "none" });
  if (file === undefined) return ok<Vault>({ kind: "ask" });
  return map(absolutePath(file), (path) => typed<Vault>({ kind: "file", file: vaultPasswordFile(path) }));
};

/** What Zod's expected types are called in a fleet's YAML. */
const expected: Readonly<Record<string, string>> = { string: "a string", boolean: "true or false", array: "a list", object: "a mapping" };

/** What the file says at a path Zod reports: Zod's issues leave the input out. */
const written = (value: unknown, path: readonly PropertyKey[]): unknown => {
  // Recursive: a path one key at a time.
  const [key, ...rest] = path;
  if (key === undefined) return value;
  const next: unknown = Array.isArray(value) && typeof key === "number" ? value[key] : mapping(value)?.[String(key)];
  return written(next, rest);
};

/**
 * The first thing wrong with server.yml, said as the operator wrote it: an
 * app by its name, a missing key as required. The schema's own messages are
 * whole sentences already.
 */
const serverProblem = (error: z.ZodError, descriptor: Fields) => {
  const issue = error.issues.at(0);
  if (issue === undefined) return "server.yml is invalid";
  const [first, index] = issue.path;
  const name = index === undefined ? undefined : written(descriptor, ["apps", index, "name"]);
  const app = first === "apps" && typeof index === "number" ? `app ${typeof name === "string" ? name : `#${String(index + 1)}`}: ` : "";
  const key = String(issue.path.at(-1) ?? "");
  if (issue.code === "unrecognized_keys") {
    const where = issue.path.length === 0 ? "" : ` (in ${issue.path.join(".")})`;
    return `server.yml: '${issue.keys.at(0) ?? ""}' is not a key it knows${where}`;
  }
  if (issue.code === "invalid_type")
    return `${app}${key} ${written(descriptor, issue.path) === undefined ? "is required" : `must be ${expected[issue.expected] ?? issue.expected}`}`;
  return `${app}${issue.message}`;
};

const inventoryField = (inventory: string, key: string) =>
  new RegExp(`${key}=([^ \\n]*)`).exec(inventory)?.[1] ?? "";

/** A field the inventory may leave out: undefined where it does. */
const optional = <T>(value: string, mint: (value: string) => Result<T, string>) =>
  value === "" ? ok<T | undefined>(undefined) : mint(value);

const inventoryOf = (text: string) => {
  const fields = [
    optional(inventoryField(text, "ansible_host"), host),
    port(inventoryField(text, "ansible_port") || sshDefaultPort),
    optional(inventoryField(text, "ansible_user"), sshUser),
    optional(inventoryField(text, "ansible_ssh_private_key_file"), keyFile),
  ] as const;
  const [address, sshPort, user, key] = fields;
  if (!address.ok) return err(`inventory.ini: ansible_host ${address.error}`);
  if (!sshPort.ok) return err(`inventory.ini: ansible_port ${sshPort.error}`);
  if (!user.ok) return err(`inventory.ini: ansible_user ${user.error}`);
  if (!key.ok) return err(`inventory.ini: ansible_ssh_private_key_file ${key.error}`);
  return ok<Inventory>({ host: address.value, port: sshPort.value, user: user.value, key: key.value });
};

const stackHosts = (stacks: readonly string[], serverDomain: Domain) =>
  Object.freeze(stacks
    .flatMap((compose) => Object.freeze([...compose.matchAll(/Host\(`([^`]*)`\)/g)].map((match) => match[1] ?? "")))
    .map((host) => (host.endsWith(`.${serverDomain}`) ? host.slice(0, -serverDomain.length - 1) : host)));

/** An app's config is plaintext, to be read and diffed; its secrets are vaulted wherever secrets.yml is. */
const appValuesProblem = (
  appValues: ServerFiles["appValues"],
  secretsMustBeVaulted: boolean,
) =>
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
export const parseServer = (files: ServerFiles) => {
  const descriptor = fields(files.descriptor);
  if (!descriptor.ok) return descriptor;
  const parsed = serverSchema.safeParse(descriptor.value);
  if (!parsed.success) return err(serverProblem(parsed.error, descriptor.value));
  const { kind, target, domain, apps } = parsed.data;
  const serverVault = vault(parsed.data);
  if (!serverVault.ok) return serverVault;
  if (target === "home" && files.inventory === undefined)
    return err("target home needs a hand-written inventory.ini next to it");
  if (target !== "home" && !files.hasTerraform) return err("no terraform/ next to it");
  if (files.vars === undefined) return err("no vars.yml next to it");
  if (files.secrets === undefined) return err("no secrets.yml next to it");
  if (isVaulted(files.vars)) return err("vars.yml is vault-encrypted; it holds settings only — secrets go in secrets.yml");
  if (target !== "multipass" && serverVault.value.kind === "none")
    return err(`target ${target} requires vault: true`);
  if (target !== "multipass" && !isVaulted(files.secrets))
    return err(`target ${target} requires a vault-encrypted secrets.yml`);
  const appValues = appValuesProblem(files.appValues, target !== "multipass");
  if (appValues !== undefined) return err(appValues);
  const vars = fields(files.vars);
  if (!vars.ok) return err(`vars.yml ${vars.error}`);
  const varsChecked = checkSettings("vars.yml", vars.value, varsSchema(kind), knownSettings(kind));
  if (!varsChecked.ok) return varsChecked;
  const backup = mapping(vars.value["restic_backup"])?.["dir"];
  const backupDir = typeof backup === "string" ? remotePath(backup) : ok(undefined);
  if (!backupDir.ok) return err(`vars.yml: restic_backup.dir ${backupDir.error}`);
  const nasRoot = vars.value["nas_root"];
  const versionFile =
    kind !== "nas"
      ? remotePath("/opt/kayra/version")
      : typeof nasRoot === "string"
        ? flatMap(remotePath(nasRoot), (dir) => remotePath(`${dir}/.kayra/version`))
        : ok(undefined);
  if (!versionFile.ok) return err(`vars.yml: nas_root ${versionFile.error}`);
  const inventory = files.inventory === undefined ? ok(undefined) : inventoryOf(files.inventory);
  if (!inventory.ok) return inventory;
  const declared: unknown = descriptor.value["apps"];
  const entries = Array.isArray(declared) ? declared : [];
  return ok<Server>({
    name: files.name,
    dir: files.dir,
    kind,
    target,
    domain,
    vault: serverVault.value,
    hasVaultedSecrets: isVaulted(files.secrets),
    apps: apps.map((app, index) => typed<App>({ name: app.name, repo: app.repo, path: app.path, entry: mapping(entries[index]) ?? {} })),
    hasTerraform: files.hasTerraform,
    buildsVm: target === "home" && vars.value["vm"] !== undefined,
    usesAcmeDns: typeof vars.value["acme_dns"] === "string" && vars.value["acme_dns"] !== "",
    inventory: inventory.value,
    backupDir: backupDir.value,
    versionFile: versionFile.value,
    stackHosts: stackHosts(files.stacks.flatMap((stack) => Object.freeze(stack.compose ?? [])), domain),
    vars: vars.value,
    files: { vars: files.vars, secrets: files.secrets, stacks: files.stacks.map((stack) => stack.name), appValues: files.appValues },
  });
};
