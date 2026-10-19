import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { textAt } from "../adapters/fs.ts";
import type { FleetRoot } from "../fleet/brand.ts";
import type { Facts, Secrets } from "./findings.ts";
import { fields, isVaulted } from "../fleet/parse.ts";
import type { Server } from "../fleet/model.ts";
import { capture } from "../interpreter/process.ts";

/** YAML as validate reads it: what it cannot read holds no values. */
const valuesOf = (text: string | undefined): Readonly<Record<string, unknown>> => {
  const parsed = text === undefined ? undefined : fields(text);
  return parsed?.ok === true ? parsed.value : {};
};

/** A secrets file's values: plaintext as is, a vault only with the server's password file; a missing file has none. */
const secretsOf = async (server: Server, file: string, text: string | undefined): Promise<Secrets> => {
  if (text === undefined) return { kind: "readable", values: {} };
  if (!isVaulted(text)) return { kind: "readable", values: valuesOf(text) };
  if (server.vault.kind !== "file")
    return { kind: "locked", reason: "vaulted, and server.yml names no vault_password_file", hint: "vault_password_file in server.yml lets kayra open it" };
  const password = server.vault.file.replace(homedir(), "~");
  if (!existsSync(server.vault.file)) return { kind: "locked", reason: `vaulted, and there is no ${password} here`, hint: "put the vault's password there" };
  const opened = await capture(["ansible-vault", "view", "--vault-password-file", server.vault.file, join(server.dir, file)], "capture");
  return opened.code === 0
    ? { kind: "readable", values: valuesOf(opened.stdout) }
    : { kind: "locked", reason: `${password} does not open it`, hint: "is it this vault's password?" };
};

/**
 * What validate needs of a server: its files as the fleet loaded them, its
 * vaults opened, and each app's app.yml from the fleet's clone (.cache/apps).
 */
export const gather = async (root: FleetRoot, server: Server): Promise<Facts> => {
  const appText = (file: string): string | undefined => server.files.appValues.find((each) => each.file === file)?.text;
  const appSecrets = await Promise.all(
    server.apps.map(async (app) => [app.name, await secretsOf(server, join("apps", `${app.name}.secrets.yml`), appText(`${app.name}.secrets.yml`))] as const),
  );
  return {
    server,
    vars: server.vars,
    varsText: server.files.vars,
    secrets: await secretsOf(server, "secrets.yml", server.files.secrets),
    stackDirs: server.files.stacks,
    appConfig: Object.fromEntries(server.apps.map((app) => [app.name, valuesOf(appText(`${app.name}.yml`))])),
    appSecrets: Object.fromEntries(appSecrets),
    manifests: Object.fromEntries(
      server.apps.flatMap((app) => {
        const manifest = textAt(join(root, ".cache", "apps", app.name, app.path, "app.yml"));
        return manifest === undefined ? [] : [[app.name, valuesOf(manifest)]];
      }),
    ),
  };
};
