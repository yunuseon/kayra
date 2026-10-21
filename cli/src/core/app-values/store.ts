import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { appValuesSchema } from "../fleet/settings.ts";
import { appSecretsIn, isEncrypted, secretsShape } from "../fleet/secrets.ts";
import { within, type AbsolutePath, type AppName, type FleetRoot } from "../fleet/brand.ts";
import type { Server } from "../fleet/model.ts";
import { textAt } from "../adapters/fs.ts";
import { sops } from "../adapters/sops.ts";
import { attempt, err, flatMap, map, ok } from "../../lib/result.ts";
import { fields } from "../../lib/yaml.ts";
import { requirements, type Edit, type ValuesReport } from "./model.ts";


const parsedValues = (text: string) => {
  const parsed = fields(text);
  if (!parsed.ok) return err("values file is not a valid YAML mapping");
  const checked = appValuesSchema.safeParse(parsed.value);
  return checked.success ? ok<Readonly<Record<string, string | number | boolean>>>(checked.data) : err("values must be strings, numbers, or booleans");
};

const present = (values: Readonly<Record<string, unknown>>, key: string) =>
  Object.hasOwn(values, key) && values[key] !== "";

const configFile = (server: Server, name: AppName) => within(server.dir, "apps", `${name}.yml`);

/** An app's secrets as secrets.yml holds them: without its key, each value a stand-in. */
const secretsShapeOf = (server: Server, name: AppName) => map(secretsShape(textAt(server.secrets.file) ?? ""), (secrets) => appSecretsIn(secrets, name));

export const inspectValues = async (root: FleetRoot, server: Server, name: AppName, dir?: AbsolutePath) => {
  const required = requirements(root, server, name, textAt, dir);
  if (!required.ok) return required;
  const config = parsedValues(textAt(configFile(server, name)) ?? "");
  if (!config.ok) return config;
  const secrets = secretsShapeOf(server, name);
  return Promise.resolve(ok<ValuesReport>({
    server: server.name, app: name, manifest: required.value.manifest,
    config: required.value.config.map((key) => ({ key, state: present(config.value, key) ? "set" : "missing" } as const)),
    secrets: required.value.secrets.map((key) => ({ key, state: secrets.ok ? (present(secrets.value, key) ? "set" : "missing") : "locked" } as const)),
    hint: secrets.ok ? null : `secrets.yml ${secrets.error}`,
  }));
};

const store = (file: string, original: string | undefined, content: string) => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    if (textAt(file) !== original) return err("values changed during this operation; retry with the latest file");
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    return ok("saved");
  } finally {
    rmSync(temporary, { force: true });
  }
};

const saved = (key: string, server: Server) => ok(`${key} saved in the fleet; apply with kayra apps ${server.name} after reviewing the change`);

const editConfig = (server: Server, name: AppName, key: string, value: string) => {
  const file = configFile(server, name);
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) return err("refusing to replace a symlinked values file");
  const original = textAt(file);
  if (original !== undefined && isEncrypted(original)) return err("configuration belongs in plaintext, not encrypted");
  const existing = parsedValues(original ?? "");
  if (!existing.ok) return existing;
  if (existing.value[key] === value) return ok(`${key} is unchanged`);
  const document = parseDocument(original ?? "{}\n");
  document.set(key, value);
  return flatMap(store(file, original, document.toString()), () => saved(key, server));
};

/** A secret into secrets.yml's app_secrets.<app>: SOPS sets it in place (one Touch ID where the key asks), a multipass server's plaintext is written. */
const editSecret = async (server: Server, name: AppName, edit: Exclude<Edit, { readonly kind: "config" }>) => {
  const { file } = server.secrets;
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) return err("refusing to replace a symlinked secrets.yml");
  const existing = secretsShapeOf(server, name);
  if (!existing.ok) return err(`secrets.yml ${existing.error}`);
  if (edit.kind === "generate" && present(existing.value, edit.key)) return ok(`${edit.key} already exists; kept it`);
  const value = edit.kind === "generate" ? randomBytes(32).toString("hex") : readFileSync(edit.file, "utf8").replace(/\r?\n$/, "");
  if (value.includes("\0") || value === "") return err("secret input must be nonempty text without NUL bytes");
  const path = ["app_secrets", name, edit.key];
  if (server.secrets.encrypted) return flatMap(await sops.set(file, path, value, server.secrets.key), () => saved(edit.key, server));
  const original = textAt(file);
  const document = parseDocument(original ?? "{}\n");
  if (document.getIn(path) === value) return ok(`${edit.key} is unchanged`);
  document.setIn(path, value);
  return flatMap(store(file, original, document.toString()), () => saved(edit.key, server));
};

export const editValues = async (root: FleetRoot, server: Server, name: AppName, edit: Edit, dir?: AbsolutePath) => {
  const required = requirements(root, server, name, textAt, dir);
  if (!required.ok) return required;
  const keys = edit.kind === "config" ? required.value.config : required.value.secrets;
  if (!keys.includes(edit.key)) return err(`${edit.key} is not a declared ${edit.kind === "config" ? "configuration" : "secret"} key`);
  const directory = edit.kind === "config" ? dirname(configFile(server, name)) : server.dir;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) return err(`refusing a symlinked ${edit.kind === "config" ? "apps directory" : "server directory"}`);
  const lock = join(directory, ".kayra-values.lock");
  const acquired = attempt(() => { mkdirSync(lock, { mode: 0o700 }); return ok(true); }, () => `app values are being edited; retry, or remove ${lock} if its writer was interrupted`);
  if (!acquired.ok) return acquired;
  try {
    return edit.kind === "config" ? editConfig(server, name, edit.key, edit.value) : await editSecret(server, name, edit);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
};
