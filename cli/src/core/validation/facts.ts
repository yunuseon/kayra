import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FleetRoot } from "../fleet/brand.ts";
import type { Facts, Secrets } from "./findings.ts";
import { yamlOf } from "../fleet/parse.ts";
import type { Server } from "../fleet/model.ts";
import { capture } from "../interpreter/process.ts";

const text = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

const mappingOf = (source: string | undefined): Readonly<Record<string, unknown>> => {
  if (source === undefined) return {};
  const parsed = yamlOf(source);
  return parsed.ok && typeof parsed.value === "object" && parsed.value !== null && !Array.isArray(parsed.value)
    ? Object.fromEntries(Object.entries(parsed.value))
    : {};
};

const isVaulted = (source: string): boolean => source.startsWith("$ANSIBLE_VAULT");

/** A secrets file's values: plaintext as is, a vault only with the server's password file; a missing file has none. */
const secretsOf = async (server: Server, path: string): Promise<Secrets> => {
  const source = text(path);
  if (source === undefined) return { kind: "readable", values: {} };
  if (!isVaulted(source)) return { kind: "readable", values: mappingOf(source) };
  if (server.vault.kind !== "file")
    return { kind: "locked", reason: "vaulted, and server.yml names no vault_password_file", hint: "vault_password_file in server.yml lets kayra open it" };
  const file = server.vault.file.replace(homedir(), "~");
  if (!existsSync(server.vault.file)) return { kind: "locked", reason: `vaulted, and there is no ${file} here`, hint: "put the vault's password there" };
  const opened = await capture(["ansible-vault", "view", "--vault-password-file", server.vault.file, path], "capture");
  return opened.code === 0
    ? { kind: "readable", values: mappingOf(opened.stdout) }
    : { kind: "locked", reason: `${file} does not open it`, hint: "is it this vault's password?" };
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
