import { err, ok } from "../../lib/result.ts";
import { typed } from "../../lib/typed.ts";
import { fields, mapping, type Fields } from "../../lib/yaml.ts";

/**
 * A server's secrets.yml: SOPS encrypts each value and leaves the keys, so
 * what it holds can be read without its key; only the values need one.
 * Beside the host's secrets it holds each app's (`app_secrets.<app>`) and
 * OpenTofu's variables (`terraform`).
 */
export const isEncrypted = (text: string) => /^sops:[ \t]*$/m.test(text);

const without = (values: Fields, keys: readonly string[]) =>
  typed<Fields>(Object.fromEntries(Object.entries(values).filter(([key]) => !keys.includes(key))));

const encryptedValue = /^ENC\[AES256_GCM,data:[^,]*,iv:[^,]*,tag:[^,]*,type:(\w+)\]$/;

/** A value of the type SOPS recorded for it: enough for a schema to check, nothing of the secret. */
const standIn = (type: string): unknown => {
  switch (type) {
    case "int":
      return 0;
    case "float":
      return 0.5;
    case "bool":
      return true;
    default:
      return "(encrypted)";
  }
};

const shaped = (value: unknown): unknown => {
  // Recursive: a tree of mappings and lists, its leaves replaced.
  if (Array.isArray(value)) return Object.freeze(value.map(shaped));
  const fields = mapping(value);
  if (fields !== undefined) return Object.freeze(Object.fromEntries(Object.entries(fields).map(([key, each]) => [key, shaped(each)] as const)));
  if (typeof value !== "string") return value;
  const type = encryptedValue.exec(value)?.[1];
  return type === undefined ? value : standIn(type);
};

/**
 * secrets.yml without its key: every key, each value a stand-in of its type.
 * A plaintext file (a multipass server's test values) as it is.
 */
export const secretsShape = (text: string) => {
  const parsed = fields(text);
  if (!parsed.ok) return parsed;
  return ok<Fields>(typed<Fields>(mapping(shaped(without(parsed.value, ["sops"]))) ?? {}));
};

/** One app's secrets, from secrets.yml's app_secrets; none where it has none. */
export const appSecretsIn = (secrets: Fields, app: string) => mapping(mapping(secrets["app_secrets"])?.[app]) ?? {};

/** The host's own secrets: what is neither an app's nor OpenTofu's. */
export const hostSecretsIn = (secrets: Fields) => without(secrets, ["app_secrets", "terraform"]);

/** OpenTofu's variables from secrets.yml's terraform mapping, as its environment takes them. */
export const terraformVariables = (secrets: Fields) => {
  const variables = mapping(secrets["terraform"]) ?? {};
  const unsupported = Object.entries(variables).find(([, value]) => !["string", "number", "boolean"].includes(typeof value));
  if (unsupported !== undefined) return err(`secrets.yml: terraform.${unsupported[0]} must be a string, number or boolean`);
  return ok<Readonly<Record<string, string>>>(Object.freeze(Object.fromEntries(Object.entries(variables).map(([key, value]) => [`TF_VAR_${key}`, String(value)] as const))));
};
