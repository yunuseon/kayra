import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { textAt } from "../adapters/fs.ts";
import type { FleetRoot } from "../fleet/brand.ts";
import type { Facts, Secrets } from "./findings.ts";
import { isVaulted } from "../fleet/parse.ts";
import { fields } from "../../lib/yaml.ts";
import type { Server } from "../fleet/model.ts";
import { capture } from "../interpreter/process.ts";
import { typed } from "../../lib/typed.ts";

/** YAML as validate reads it: what it cannot read holds no values. */
const valuesOf = (text: string | undefined) => {
  const parsed = text === undefined ? undefined : fields(text);
  return parsed?.ok === true ? parsed.value : typed<Readonly<Record<string, unknown>>>({});
};

/** A secrets file's values: plaintext as is, a vault only with the server's password file; a missing file has none. */
const secretsOf = async (server: Server, file: string, text: string | undefined) => {
  if (text === undefined) return typed<Secrets>({ kind: "readable", values: {} });
  if (!isVaulted(text)) return typed<Secrets>({ kind: "readable", values: valuesOf(text) });
  if (server.vault.kind !== "file")
    return typed<Secrets>({ kind: "locked", reason: "vaulted, and server.yml names no vault_password_file", hint: "vault_password_file in server.yml lets kayra open it" });
  const password = server.vault.file.replace(homedir(), "~");
  if (!existsSync(server.vault.file)) return typed<Secrets>({ kind: "locked", reason: `vaulted, and there is no ${password} here`, hint: "put the vault's password there" });
  const opened = await capture(["ansible-vault", "view", "--vault-password-file", server.vault.file, join(server.dir, file)], "capture");
  return typed<Secrets>(opened.code === 0 ? { kind: "readable", values: valuesOf(opened.stdout) } : { kind: "locked", reason: `${password} does not open it`, hint: "is it this vault's password?" });
};

/**
 * What validate needs of a server: its files as the fleet loaded them, its
 * vaults opened, and each app's app.yml from the fleet's clone (.cache/apps).
 */
export const gather = async (root: FleetRoot, server: Server) => {
  const appText = (file: string) => server.files.appValues.find((each) => each.file === file)?.text;
  const appSecrets = await Promise.all(
    server.apps.map(async (app) => [app.name, await secretsOf(server, join("apps", `${app.name}.secrets.yml`), appText(`${app.name}.secrets.yml`))] as const),
  );
  return typed<Facts>({
    server,
    vars: server.vars,
    varsText: server.files.vars,
    secrets: await secretsOf(server, "secrets.yml", server.files.secrets),
    stackDirs: server.files.stacks,
    appConfig: Object.fromEntries(server.apps.map((app) => [app.name, valuesOf(appText(`${app.name}.yml`))] as const)),
    appSecrets: Object.fromEntries(appSecrets),
    manifests: Object.fromEntries(
      // eslint-disable-next-line functional/prefer-immutable-types -- an app.yml's values are unknown, read only
      server.apps.flatMap((app) => {
        const manifest = textAt(join(root, ".cache", "apps", app.name, app.path, "app.yml"));
        return manifest === undefined ? Object.freeze([]) : Object.freeze([[app.name, valuesOf(manifest)] as const]);
      }),
    ),
  });
};
