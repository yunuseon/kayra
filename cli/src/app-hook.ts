import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { github } from "./core/app-hook/github.ts";
import { ensureHook, githubRepo, hookUrl } from "./core/app-hook/hooks.ts";
import { absolutePath, appNameSchema, fleetRoot, serverNameSchema } from "./core/fleet/brand.ts";
import { loadFleet } from "./core/fleet/load.ts";
import { isVaulted } from "./core/fleet/parse.ts";
import { err, flatMap, type Result } from "./lib/result.ts";
import { fields } from "./lib/yaml.ts";

const input = z.strictObject({ root: z.string(), server: serverNameSchema, app: appNameSchema });

/** secrets.yml, opened with the password the step was given (ANSIBLE_VAULT_PASSWORD_FILE) where it is a vault. */
const secretsOf = (dir: string): Result<Readonly<Record<string, unknown>>, string> => {
  const file = join(dir, "secrets.yml");
  const text = readFileSync(file, "utf8");
  if (!isVaulted(text)) return fields(text);
  const opened = spawnSync("ansible-vault", ["view", file], { encoding: "utf8" });
  return opened.status === 0 ? fields(opened.stdout) : err("cannot open secrets.yml; configure vault_password_file or give the vault password");
};

const run = async (): Promise<Result<readonly string[], string>> => {
  const request = input.safeParse(JSON.parse(process.argv[2] ?? "null"));
  if (!request.success) return err("invalid app hook request");
  const fleet = flatMap(absolutePath(request.data.root), (path) => loadFleet(fleetRoot(path)));
  if (!fleet.ok) return err(`the fleet could not be loaded: ${fleet.error}`);
  const server = fleet.value.servers.find((each) => each.name === request.data.server);
  if (server === undefined) return err(`no server ${request.data.server}`);
  const app = server.apps.find((each) => each.name === request.data.app);
  if (app === undefined) return err(`${request.data.app} is not in ${server.name}'s server.yml`);
  if (server.target === "multipass") return err(`GitHub cannot reach ${server.name}, a multipass VM: deploy there with kayra app deploy`);
  const repo = githubRepo(app.repo);
  if (repo === undefined) return err(`${app.repo} is not a github.com repository; kayra sets up hooks on GitHub only so far`);
  const secrets = secretsOf(server.dir);
  if (!secrets.ok) return secrets;
  const token = secrets.value["git_token"];
  const webhook = secrets.value["webhook_secret"];
  if (typeof token !== "string" || typeof webhook !== "string") return err(`${server.name}'s secrets.yml needs git_token and webhook_secret`);
  return ensureHook(github(), repo, hookUrl(server.domain, app.name), { token, webhook });
};

const result = await run().catch(() => err("the hook could not be set up; check gh auth status and the vault"));
if (result.ok) process.stdout.write(`${result.value.join("\n")}\n`);
else {
  process.stderr.write(`${result.error}\n`);
  // eslint-disable-next-line functional/immutable-data -- exit after flushing diagnostics
  process.exitCode = 1;
}
