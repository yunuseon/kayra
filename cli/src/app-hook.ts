import { readFileSync } from "node:fs";
import { z } from "zod";
import { forgeRepo } from "./lib/forge-repo.ts";
import { ensureHook, hookApi, hookUrl, type Answer, type Http } from "./core/app-hook/hooks.ts";
import { operatorToken, tokenVariable } from "./core/app-hook/token.ts";
import { absolutePath, appNameSchema, fleetRoot, serverNameSchema } from "./core/fleet/brand.ts";
import { loadFleet } from "./core/fleet/load.ts";
import { takesWebhooks } from "./core/recipes/app-hook.ts";
import { err, flatMap, type Result } from "./lib/result.ts";
import { fields } from "./lib/yaml.ts";

const input = z.strictObject({ root: z.string(), server: serverNameSchema, app: appNameSchema });

/** secrets.yml as kayra opened it for this step (KAYRA_SECRETS). */
const secretsOf = (): Result<Readonly<Record<string, unknown>>, string> => {
  const file = process.env["KAYRA_SECRETS"];
  return file === undefined ? err("kayra opened no secrets.yml for this step") : fields(readFileSync(file, "utf8"));
};

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const http: Http = async (url, init): Promise<Answer> => {
  const response = await fetch(url, init);
  return { status: response.status, json: parsedJson(await response.text()) };
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
  const takes = takesWebhooks(server);
  if (!takes.ok) return takes;
  const repo = forgeRepo(app.repo);
  if (repo === undefined) return err(`${app.repo} is on no forge kayra knows (GitHub, GitLab, Forgejo or Gitea): add the hook by hand, or let deploy_poll find pushes`);
  const operator = operatorToken(repo);
  if (operator === undefined) return err(`no token for ${new URL(repo.origin).host}: set ${tokenVariable(new URL(repo.origin).host)} to one with admin rights on ${repo.owner}/${repo.name}`);
  const secrets = secretsOf();
  if (!secrets.ok) return secrets;
  const platform = secrets.value["git_token"];
  const webhook = secrets.value["webhook_secret"];
  if (typeof platform !== "string" || typeof webhook !== "string") return err(`${server.name}'s secrets.yml needs git_token and webhook_secret`);
  const done = await ensureHook(hookApi(repo, http), hookUrl(server.domain, app.name), { platform, operator: operator.token }, webhook);
  return done.ok ? { ok: true, value: [...done.value, `  (as you, with ${operator.from})`] } : done;
};

const result = await run().catch(() => err("the hook could not be set up; check the forge's address, the tokens and secrets.yml"));
if (result.ok) process.stdout.write(`${result.value.join("\n")}\n`);
else {
  process.stderr.write(`${result.error}\n`);
  // eslint-disable-next-line functional/immutable-data -- exit after flushing diagnostics
  process.exitCode = 1;
}
