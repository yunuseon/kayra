import { err, ok, type Result } from "../../lib/result.ts";
import { typed } from "../../lib/typed.ts";

/** A repository on a forge, by owner and name. */
export type Repo = { readonly owner: string; readonly name: string };

/** A push webhook as a forge holds it: where it posts, and its id there. */
export type Hook = { readonly id: number; readonly url: string };

/**
 * What `kayra app hook` asks of the forge an app's repository is on. GitHub is
 * the one today; another forge is another implementation of this.
 */
export type Forge = {
  /** Whether a token can read the repository, as the platform's builder will. */
  readonly readable: (repo: Repo, token: string) => Promise<Result<true, string>>;
  readonly hooks: (repo: Repo) => Promise<Result<readonly Hook[], string>>;
  /** A push hook to `url`, signed with `secret`: created, or the one with `id` set to it. */
  readonly save: (repo: Repo, url: string, secret: string, id: number | undefined) => Promise<Result<Hook, string>>;
};

/** owner/name of a github.com repository URL, or nothing for any other. */
export const githubRepo = (url: string) => {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  return match?.[1] === undefined || match[2] === undefined ? undefined : typed<Repo>({ owner: match[1], name: match[2] });
};

export const hookUrl = (domain: string, app: string) => `https://deploy.${domain}/hook/${app}`;

/**
 * The app's repository reachable by the platform's token, and exactly one push
 * hook to its deployer: an existing one is updated, so its secret is the
 * platform's now, never a second added.
 */
export const ensureHook = async (forge: Forge, repo: Repo, url: string, secrets: { readonly token: string; readonly webhook: string }) => {
  const readable = await forge.readable(repo, secrets.token);
  if (!readable.ok) return readable;
  const existing = await forge.hooks(repo);
  if (!existing.ok) return existing;
  const same = existing.value.filter((hook) => hook.url === url);
  if (same.length > 1) return err(`${repo.owner}/${repo.name} has ${String(same.length)} hooks to ${url}; delete all but one`);
  const saved = await forge.save(repo, url, secrets.webhook, same[0]?.id);
  if (!saved.ok) return saved;
  return ok(typed<readonly string[]>([
    `✓ the platform's token reads ${repo.owner}/${repo.name}`,
    `✓ push hook ${same[0] === undefined ? "created" : "updated"}: ${url} (id ${String(saved.value.id)})`,
  ]));
};
