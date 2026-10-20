import { z } from "zod";
import { appManifestSchema } from "../fleet/settings.ts";
import type { Server } from "../fleet/model.ts";
import { err, flatMap, ok } from "../../lib/result.ts";
import { fields } from "../../lib/yaml.ts";
import { within, type AbsolutePath, type AppName, type FleetRoot, type ServerName } from "../fleet/brand.ts";

export const valueKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "expected an environment variable name");
export const valueStateSchema = z.enum(["set", "missing", "locked"]);
export const valuesReportSchema = z.object({
  server: z.string(),
  app: z.string(),
  manifest: z.string(),
  config: z.array(z.object({ key: z.string(), state: valueStateSchema })),
  secrets: z.array(z.object({ key: z.string(), state: valueStateSchema })),
  hint: z.string().nullable(),
});
export type ValuesReport = {
  readonly server: ServerName; readonly app: AppName; readonly manifest: string;
  readonly config: readonly { readonly key: string; readonly state: "set" | "missing" | "locked" }[];
  readonly secrets: readonly { readonly key: string; readonly state: "set" | "missing" | "locked" }[];
  readonly hint: string | null;
};

export type Edit =
  | { readonly kind: "config"; readonly key: string; readonly value: string }
  | { readonly kind: "import"; readonly key: string; readonly file: string }
  | { readonly kind: "generate"; readonly key: string };

export const editSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("config"), key: valueKeySchema, value: z.string().refine((value) => !value.includes("\0"), "NUL is not an environment value") }),
  z.strictObject({ kind: z.literal("import"), key: valueKeySchema, file: z.string().min(1) }),
  z.strictObject({ kind: z.literal("generate"), key: valueKeySchema }),
]);

export const requirements = (root: FleetRoot, server: Server, name: AppName, read: (path: AbsolutePath) => string | undefined, dir?: AbsolutePath) => {
  if (server.kind !== "platform") return err("only platform servers have app values");
  const app = server.apps.find((each) => each.name === name);
  if (app === undefined) return err(`app '${name}' is not registered in ${server.name}'s server.yml`);
  const manifest = dir === undefined ? within(root, ".cache", "apps", app.name, app.path, "app.yml") : within(dir, "app.yml");
  const source = read(manifest);
  if (source === undefined) return err(`no app.yml for ${name}; provide the local app directory with --dir`);
  const parsed = flatMap(fields(source), (value) => {
    const checked = appManifestSchema.safeParse(value);
    return checked.success ? ok({ name: checked.data.name, config: Object.freeze(checked.data.config ?? []), secrets: Object.freeze(checked.data.secrets ?? []) } as const) : err("app.yml does not match the app contract");
  });
  if (!parsed.ok) return err(`app.yml for ${name} is invalid`);
  if (parsed.value.name !== name) return err(`app.yml names another app, not ${name}`);
  const { config, secrets } = parsed.value;
  if ([...config, ...secrets].some((key) => !valueKeySchema.safeParse(key).success))
    return err("app.yml contains an invalid configuration or secret name");
  if (config.some((key) => secrets.includes(key))) return err("app.yml declares a key as both configuration and secret");
  return ok({ manifest, config: Object.freeze(config), secrets: Object.freeze(secrets) } as const);
};

