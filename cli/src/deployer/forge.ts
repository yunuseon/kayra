import type { Result } from "../result.ts";
import type { Sha } from "./brand.ts";
import { forgejo } from "./forgejo.ts";
import { github } from "./github.ts";

export type State = "pending" | "success" | "failure" | "error";
export type Context = "kayra/build" | "kayra/deploy";

export type CommitStatus = { readonly context: Context; readonly state: State; readonly description: string; readonly target: string };

/** What the deployer needs of the forge an app's repository lives on. */
export type Forge = {
  /** Fails with "no answer" or "HTTP <status>". */
  readonly postStatus: (commit: Sha, status: CommitStatus) => Promise<Result<void, string>>;
};

export type Fetch = (
  url: string,
  init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body: string },
) => Promise<{ readonly ok: boolean; readonly status: number }>;

export type ForgeRepo = { readonly kind: "github" | "forgejo"; readonly origin: string; readonly owner: string; readonly name: string };

/** GitHub for https://github.com, a Forgejo for any other host; undefined for a URL neither understands. */
export const forgeRepo = (repo: string): ForgeRepo | undefined => {
  const match = /^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(repo);
  if (match === null) return undefined;
  const [, origin, owner, name] = match;
  if (origin === undefined || owner === undefined || name === undefined) return undefined;
  return { kind: origin === "https://github.com" ? "github" : "forgejo", origin, owner, name };
};

export const forge = (repo: ForgeRepo, token: string, fetch: Fetch): Forge => (repo.kind === "github" ? github : forgejo)(repo, token, fetch);
