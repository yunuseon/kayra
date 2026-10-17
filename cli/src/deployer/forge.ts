import type { Sha } from "./brand.ts";

export type State = "pending" | "success" | "failure" | "error";
export type Context = "kayra/build" | "kayra/deploy";

export type StatusRequest = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

/**
 * A commit status on the app's forge, linking to the run: GitHub's REST API,
 * or for any other host Forgejo's (Gitea's statuses endpoint). Undefined for a
 * repo URL neither understands.
 */
export const statusRequest = (
  repo: string,
  commit: Sha,
  status: { readonly context: Context; readonly state: State; readonly description: string; readonly target: string },
  token: string,
): StatusRequest | undefined => {
  const match = /^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(repo);
  if (match === null) return undefined;
  const [, origin, owner, name] = match;
  if (origin === undefined || owner === undefined || name === undefined) return undefined;
  const body = JSON.stringify({ state: status.state, context: status.context, description: status.description, target_url: status.target });
  return origin === "https://github.com"
    ? {
        url: `https://api.github.com/repos/${owner}/${name}/statuses/${commit}`,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body,
      }
    : {
        url: `${origin}/api/v1/repos/${owner}/${name}/statuses/${commit}`,
        headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
        body,
      };
};
