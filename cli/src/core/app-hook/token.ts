import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ForgeRepo } from "../../lib/forge-repo.ts";
import { fields } from "../../lib/yaml.ts";

/** KAYRA_FORGE_TOKEN_<HOST>: github.com → KAYRA_FORGE_TOKEN_GITHUB_COM. */
export const tokenVariable = (host: string) => `KAYRA_FORGE_TOKEN_${host.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

/** A CLI's answer, if that CLI is here at all: its absence is no error, only no answer. */
const asked = (program: string, args: readonly string[]) => {
  const result = spawnSync(program, args, { encoding: "utf8" });
  const token = result.status === 0 ? result.stdout.trim() : "";
  return token === "" ? undefined : token;
};

/** tea keeps its logins in a YAML file; read, not run. */
type Env = Readonly<Record<string, string | undefined>>;

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Object.entries(value).find(([name]) => name === key)?.[1] : undefined;

const teaToken = (host: string, home: string, env: Env) => {
  const files = [
    join(env["XDG_CONFIG_HOME"] ?? join(home, ".config"), "tea", "config.yml"),
    join(home, "Library", "Application Support", "tea", "config.yml"),
  ];
  const file = files.find((each) => existsSync(each));
  if (file === undefined) return undefined;
  const parsed = fields(readFileSync(file, "utf8"));
  const logins: unknown = parsed.ok ? parsed.value["logins"] : undefined;
  const list: readonly unknown[] = Array.isArray(logins) ? logins : [];
  const login = list.find((each) => {
    const url = field(each, "url");
    return typeof url === "string" && URL.canParse(url) && new URL(url).host === host;
  });
  const token = field(login, "token");
  return typeof token === "string" && token !== "" ? token : undefined;
};

/**
 * The operator's token for a forge (hooks need a repository admin, which the
 * platform's token is not): KAYRA_FORGE_TOKEN_<HOST> first; else, only if it
 * happens to be here, the forge CLI's own login (gh, tea, glab). No CLI is
 * ever required.
 */
export const operatorToken = (repo: ForgeRepo, env: Env = process.env, home = homedir()): { readonly token: string; readonly from: string } | undefined => {
  const host = new URL(repo.origin).host;
  const fromEnv = env[tokenVariable(host)];
  if (fromEnv !== undefined && fromEnv !== "") return { token: fromEnv, from: tokenVariable(host) };
  const fallback =
    repo.kind === "github" ? asked("gh", ["auth", "token", "--hostname", host])
    : repo.kind === "gitlab" ? asked("glab", ["config", "get", "token", "--host", host])
    : teaToken(host, home, env);
  const cli = repo.kind === "github" ? "gh" : repo.kind === "gitlab" ? "glab" : "tea";
  return fallback === undefined ? undefined : { token: fallback, from: `${cli}'s login` };
};
