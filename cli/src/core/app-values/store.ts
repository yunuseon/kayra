import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { appValuesSchema } from "../fleet/settings.ts";
import { isVaulted } from "../fleet/parse.ts";
import { within, type AbsolutePath, type AppName, type FleetRoot } from "../fleet/brand.ts";
import type { Server } from "../fleet/model.ts";
import { textAt } from "../adapters/fs.ts";
import { spawned } from "../interpreter/process.ts";
import { vault } from "../recipes/steps.ts";
import { attempt, err, ok } from "../../lib/result.ts";
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

const fileOf = (server: Server, name: AppName, secret: boolean) =>
  within(server.dir, "apps", `${name}${secret ? ".secrets" : ""}.yml`);

const opened = async (server: Server, file: string, source: string | undefined) => {
  if (source === undefined) return ok("");
  if (!isVaulted(source)) {
    if (server.vault.kind !== "none") return err("secrets must be Ansible Vault encrypted for this server");
    return ok(source);
  }
  const result = await spawned(
    ["ansible-vault", "view", file],
    { stdout: "capture", stderr: "capture", stdin: { kind: "none" } },
    vault(server).env,
  );
  return result.code === 0 ? ok(result.stdout) : err("cannot open app secrets; configure vault_password_file or provide the vault password through the client");
};

export const inspectValues = async (root: FleetRoot, server: Server, name: AppName, dir?: AbsolutePath) => {
  const required = requirements(root, server, name, textAt, dir);
  if (!required.ok) return required;
  const config = parsedValues(textAt(fileOf(server, name, false)) ?? "");
  if (!config.ok) return config;
  const file = fileOf(server, name, true);
  const source = textAt(file);
  const secret = source !== undefined && isVaulted(source) && server.vault.kind === "ask"
    ? err("configure vault_password_file to inspect encrypted secret presence without prompting")
    : await opened(server, file, source);
  const values = secret.ok ? parsedValues(secret.value) : secret;
  if (secret.ok && !values.ok) return values;
  return ok<ValuesReport>({
    server: server.name, app: name, manifest: required.value.manifest,
    config: required.value.config.map((key) => ({ key, state: present(config.value, key) ? "set" : "missing" } as const)),
    secrets: required.value.secrets.map((key) => ({ key, state: values.ok ? (present(values.value, key) ? "set" : "missing") : "locked" } as const)),
    hint: values.ok ? null : values.error,
  });
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

const editFile = async (server: Server, name: AppName, edit: Edit) => {
  const file = fileOf(server, name, edit.kind !== "config");
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) return err("refusing to replace a symlinked values file");
  const original = textAt(file);
  if (edit.kind === "config" && original !== undefined && isVaulted(original)) return err("configuration belongs in plaintext, not a vault");
  const source = edit.kind === "config" ? ok(original ?? "") : await opened(server, file, original);
  if (!source.ok) return source;
  const existing = parsedValues(source.value);
  if (!existing.ok) return existing;
  if (edit.kind === "generate" && present(existing.value, edit.key)) return ok(`${edit.key} already exists; kept it`);
  const value = edit.kind === "config" ? edit.value : edit.kind === "generate" ? randomBytes(32).toString("hex") : readFileSync(edit.file, "utf8").replace(/\r?\n$/, "");
  if (value.includes("\0") || (edit.kind !== "config" && value === "")) return err("secret input must be nonempty text without NUL bytes");
  if (existing.value[edit.key] === value) return ok(`${edit.key} is unchanged`);
  const document = parseDocument(source.value || "{}\n");
  document.set(edit.key, value);
  const plaintext = document.toString();
  if (edit.kind === "config" || (server.vault.kind === "none" && (original === undefined || !isVaulted(original)))) {
    const saved = store(file, original, plaintext);
    return saved.ok ? ok(`${edit.key} saved in the fleet; apply with kayra apps ${server.name} after reviewing the change`) : saved;
  }
  // Vault receives plaintext over stdin; only ciphertext reaches a temporary file.
  const encrypted = await spawned(
    ["ansible-vault", "encrypt", "--output", "-"],
    { stdout: "capture", stderr: "capture", stdin: { kind: "given", text: plaintext } },
    vault(server).env,
  );
  if (encrypted.code !== 0 || !isVaulted(encrypted.stdout)) return err("could not encrypt app secrets; the existing file was not changed");
  const saved = store(file, original, encrypted.stdout);
  return saved.ok ? ok(`${edit.key} saved in the fleet; apply with kayra apps ${server.name} after reviewing the change`) : saved;
};

export const editValues = async (root: FleetRoot, server: Server, name: AppName, edit: Edit, dir?: AbsolutePath) => {
  const required = requirements(root, server, name, textAt, dir);
  if (!required.ok) return required;
  const keys = edit.kind === "config" ? required.value.config : required.value.secrets;
  if (!keys.includes(edit.key)) return err(`${edit.key} is not a declared ${edit.kind === "config" ? "configuration" : "secret"} key`);
  const directory = dirname(fileOf(server, name, edit.kind !== "config"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) return err("refusing a symlinked apps directory");
  const lock = join(directory, ".kayra-values.lock");
  const acquired = attempt(() => { mkdirSync(lock, { mode: 0o700 }); return ok(true); }, () => "app values are being edited; retry, or remove apps/.kayra-values.lock if its writer was interrupted");
  if (!acquired.ok) return acquired;
  try {
    return await editFile(server, name, edit);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
};
