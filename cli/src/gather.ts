import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FleetRoot } from "./brand.ts";
import type { Facts, Secrets } from "./commands/validate.ts";
import { yamlOf, type Server } from "./fleet.ts";
import { capture } from "./interpret.ts";

const text = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

const mappingOf = (source: string | undefined): Readonly<Record<string, unknown>> => {
  if (source === undefined) return {};
  const parsed = yamlOf(source);
  return parsed.ok && typeof parsed.value === "object" && parsed.value !== null && !Array.isArray(parsed.value)
    ? Object.fromEntries(Object.entries(parsed.value))
    : {};
};

const vaulted = (source: string): boolean => source.startsWith("$ANSIBLE_VAULT");

/** A secrets file's values: plaintext as is, a vault only with the server's password file. */
const secretsOf = async (server: Server, path: string): Promise<Secrets> => {
  const source = text(path);
  if (source === undefined) return { kind: "locked", reason: "missing" };
  if (!vaulted(source)) return { kind: "readable", values: mappingOf(source) };
  if (server.vault.kind !== "file" || !existsSync(server.vault.file))
    return { kind: "locked", reason: "vaulted, and no vault password file here" };
  const opened = await capture(["ansible-vault", "view", "--vault-password-file", server.vault.file, path], "capture");
  return opened.code === 0
    ? { kind: "readable", values: mappingOf(opened.stdout) }
    : { kind: "locked", reason: "the vault password does not open it" };
};

const appPath = (entry: string): string => {
  const parsed: unknown = JSON.parse(entry);
  const path = typeof parsed === "object" && parsed !== null && "path" in parsed ? parsed.path : undefined;
  return typeof path === "string" ? path : ".";
};

/** What validate needs of a server, read from the fleet (and its clones under .cache/apps). */
export const gather = async (root: FleetRoot, server: Server): Promise<Facts> => {
  const varsText = text(join(server.dir, "vars.yml")) ?? "";
  const stacks = join(server.dir, "stacks");
  const appSecrets = await Promise.all(
    server.apps.map(async (app) => [app.name, await secretsOf(server, join(server.dir, "apps", `${app.name}.secrets.yml`))] as const),
  );
  return {
    server,
    vars: mappingOf(varsText),
    varsText,
    secrets: await secretsOf(server, join(server.dir, "secrets.yml")),
    stackDirs: existsSync(stacks)
      ? readdirSync(stacks, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .toSorted()
      : [],
    appConfig: Object.fromEntries(server.apps.map((app) => [app.name, mappingOf(text(join(server.dir, "apps", `${app.name}.yml`)))])),
    appSecrets: Object.fromEntries(appSecrets),
    manifests: Object.fromEntries(
      server.apps.flatMap((app) => {
        const manifest = text(join(root, ".cache", "apps", app.name, appPath(app.entry), "app.yml"));
        return manifest === undefined ? [] : [[app.name, mappingOf(manifest)]];
      }),
    ),
  };
};
