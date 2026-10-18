import type { OperationInfo, OperationName, ServerFacts } from "../../cli/src/clients/api/contract.gen.ts";

export const reaches = {
  up: { label: "Up", icon: "↑" },
  provision: { label: "Provision", icon: "+" },
  deploy: { label: "Deploy", icon: "↑" },
  setup: { label: "Setup", icon: "⚙" },
  plan: { label: "Plan", icon: "≡" },
  verify: { label: "Verify", icon: "✓" },
  apps: { label: "Register apps", icon: "▦" },
  hosts: { label: "Local hosts", icon: "⌂" },
  ssh: { label: "SSH terminal", icon: ">_" },
  "ssh.exec": { label: "SSH command", icon: ">" },
  down: { label: "Destroy", icon: "×" },
  adopt: { label: "Adopt", icon: "+" },
  "backup.test": { label: "Test backup", icon: "✓" },
  "app.check": { label: "Check app repository", icon: "✓" },
  "app.purge": { label: "Purge app data", icon: "×" },
  "app.runs": { label: "App runs", icon: "≡" },
  "app.log": { label: "App log", icon: "≡" },
  "app.deploy": { label: "Deploy app", icon: "↑" },
  "app.releases": { label: "App releases", icon: "≡" },
  "app.rollback": { label: "Roll back app", icon: "↶" },
  job: { label: "Run job", icon: "▶" },
  status: { label: "Status", icon: "●" },
  validate: { label: "Validate", icon: "✓" },
  doctor: { label: "Doctor", icon: "✓" },
  certs: { label: "Local certificates", icon: "◇" },
  version: { label: "Version", icon: "i" },
} satisfies Readonly<Record<OperationName, { readonly label: string; readonly icon: string }>>;

export type Draft = { readonly name: OperationName; readonly input: Readonly<Record<string, unknown>> };
export type Values = Readonly<Record<string, string | boolean>>;
type Schema = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);
const object = (value: unknown): Schema => (isObject(value) ? value : {});
const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export type Field = {
  readonly name: string;
  readonly type: unknown;
  readonly required: boolean;
  readonly description: string;
  readonly choices: readonly string[];
  readonly default: unknown;
  readonly minLength: number | undefined;
  readonly pattern: string | undefined;
  readonly supported: boolean;
};
export const fields = (schema: Schema): readonly Field[] =>
  Object.entries(object(schema["properties"])).map(([name, value]) => {
    const field = object(value);
    return {
      name,
      type: field["type"],
      required: strings(schema["required"]).includes(name),
      description: typeof field["description"] === "string" ? field["description"] : "",
      choices: strings(field["enum"]),
      default: field["default"],
      minLength: typeof field["minLength"] === "number" ? field["minLength"] : undefined,
      pattern: typeof field["pattern"] === "string" ? field["pattern"] : undefined,
      supported:
        field["type"] === "string" ||
        field["type"] === "boolean" ||
        (field["type"] === "array" && object(field["items"])["type"] === "string"),
    };
  });

const editValue = (value: unknown): string | boolean =>
  typeof value === "boolean" ? value : typeof value === "string" ? value : Array.isArray(value) ? strings(value).join("\n") : "";
export const defaults = (schema: Schema, seed: Schema): Values =>
  Object.fromEntries(fields(schema).map((field) => [field.name, editValue(seed[field.name] ?? field.default)]));

export const inputOf = (schema: Schema, values: Values): Schema =>
  Object.fromEntries(
    fields(schema).flatMap((field): readonly (readonly [string, unknown])[] => {
      const value = values[field.name];
      if (field.type === "boolean") return [[field.name, value === true]];
      if (typeof value !== "string" || value === "") return [];
      return [[field.name, field.type === "array" ? value.split(/\r?\n/) : value]];
    }),
  );

export const onServer = (catalog: readonly OperationInfo[], server: ServerFacts): readonly OperationInfo[] =>
  catalog.filter(
    (operation) =>
      (operation.scope === "app" && server.kind === "platform") ||
      (operation.scope === "server" &&
        (server.commands.some((name) => name === operation.name) ||
          operation.name === "ssh" ||
          operation.name === "ssh.exec" ||
          (operation.name === "hosts" && server.target === "multipass"))),
  );
