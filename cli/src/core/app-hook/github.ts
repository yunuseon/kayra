import { spawnSync } from "node:child_process";
import { err, ok, type Result } from "../../lib/result.ts";
import { typed } from "../../lib/typed.ts";
import type { Forge, Hook, Repo } from "./hooks.ts";

/**
 * GitHub, as the operator is logged in to it with the gh CLI (hooks need a
 * repository admin, which the platform's own token is not), and as the
 * platform's token sees it. Secrets reach gh on stdin, never as arguments.
 */
const gh = (args: readonly string[], input?: string) => {
  const result = spawnSync("gh", ["api", ...args], { encoding: "utf8", ...(input === undefined ? {} : { input }) });
  if (result.error !== undefined) return err("gh is not installed: brew install gh, then gh auth login");
  return result.status === 0 ? ok<unknown>(JSON.parse(result.stdout || "null")) : err(result.stderr.trim() || `gh api ${args.join(" ")} failed`);
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Object.entries(value).find(([name]) => name === key)?.[1] : undefined;

/** A GET and what answered it: all the platform's token is asked. */
export type Get = (url: string, headers: Readonly<Record<string, string>>) => Promise<{ readonly ok: boolean; readonly status: number }>;

const get: Get = (url, headers) => fetch(url, { headers });

const hookOf = (value: unknown) => {
  const id = field(value, "id");
  const url = field(field(value, "config"), "url");
  return typeof id === "number" && typeof url === "string" ? typed<Hook>({ id, url }) : undefined;
};

export const github = (asked: Get = get): Forge => ({
  readable: async (repo: Repo, token: string): Promise<Result<true, string>> => {
    const response = await asked(`https://api.github.com/repos/${repo.owner}/${repo.name}`, {
      authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
    }).catch(() => undefined);
    if (response === undefined) return err("GitHub did not answer");
    return response.ok
      ? ok(true)
      : err(`the platform's git_token cannot read ${repo.owner}/${repo.name} (${String(response.status)}): give it Contents read and Commit statuses read/write on this repository`);
  },
  hooks: (repo: Repo) => {
    const listed = gh([`repos/${repo.owner}/${repo.name}/hooks`]);
    if (!listed.ok) return Promise.resolve(listed);
    const hooks = Array.isArray(listed.value) ? listed.value.flatMap((each) => { const hook = hookOf(each); return hook === undefined ? Object.freeze([]) : Object.freeze([hook]); }) : [];
    return Promise.resolve(ok(Object.freeze(hooks)));
  },
  save: (repo: Repo, url: string, secret: string, id: number | undefined) => {
    const body = JSON.stringify({ active: true, events: ["push"], config: { url, content_type: "json", secret, insecure_ssl: "0" } });
    const saved = gh(
      id === undefined ? ["--method", "POST", `repos/${repo.owner}/${repo.name}/hooks`, "--input", "-"] : ["--method", "PATCH", `repos/${repo.owner}/${repo.name}/hooks/${String(id)}`, "--input", "-"],
      body,
    );
    if (!saved.ok) return Promise.resolve(err(saved.error.replaceAll(secret, "…")));
    const hook = hookOf(saved.value);
    return Promise.resolve(hook === undefined ? err("GitHub answered without the hook") : ok(hook));
  },
});
