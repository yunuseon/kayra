import { typed } from "./typed.ts";

export type Kind = "github" | "forgejo" | "gitlab";

/** owner is a GitLab group path where there is one (`group/subgroup`). */
export type ForgeRepo = { readonly kind: Kind; readonly origin: string; readonly owner: string; readonly name: string };

const kinds: Readonly<Record<string, Kind>> = { "https://github.com": "github", "https://gitlab.com": "gitlab" };

/**
 * GitHub for https://github.com, GitLab for https://gitlab.com, a Forgejo for any other host; undefined for a URL none understands.
 * The deployer (statuses, webhook signatures) and kayra (setting up those webhooks) read a repository the same way.
 */
export const forgeRepo = (repo: string) => {
  const match = /^(https?:\/\/[^/]+)\/(.+)\/([^/]+?)(\.git)?\/?$/.exec(repo);
  if (match === null) return undefined;
  const [, origin, owner, name] = match;
  if (origin === undefined || owner === undefined || name === undefined) return undefined;
  return typed<ForgeRepo | undefined>({ kind: kinds[origin] ?? "forgejo", origin, owner, name });
};
