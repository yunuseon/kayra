import type { IncomingHttpHeaders } from "node:http";
import type { Result } from "../result.ts";
import type { Sha } from "./brand.ts";
import { forgejo } from "./forgejo.ts";
import { github } from "./github.ts";
import { gitlab } from "./gitlab.ts";

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

export type Kind = "github" | "forgejo" | "gitlab";

/** owner is a GitLab group path where there is one (`group/subgroup`). */
export type ForgeRepo = { readonly kind: Kind; readonly origin: string; readonly owner: string; readonly name: string };

/** One forge: its API with the platform's token, and how its push webhooks prove they carry the platform's secret. */
export type Adapter = {
  readonly api: (repo: ForgeRepo, token: string, fetch: Fetch) => Forge;
  readonly signed: (secret: string, body: Buffer, headers: IncomingHttpHeaders) => boolean;
};

const adapters: Readonly<Record<Kind, Adapter>> = { github, forgejo, gitlab };

const kinds: Readonly<Record<string, Kind>> = { "https://github.com": "github", "https://gitlab.com": "gitlab" };

/** GitHub for https://github.com, GitLab for https://gitlab.com, a Forgejo for any other host; undefined for a URL none understands. */
export const forgeRepo = (repo: string): ForgeRepo | undefined => {
  const match = /^(https?:\/\/[^/]+)\/(.+)\/([^/]+?)(\.git)?\/?$/.exec(repo);
  if (match === null) return undefined;
  const [, origin, owner, name] = match;
  if (origin === undefined || owner === undefined || name === undefined) return undefined;
  return { kind: kinds[origin] ?? "forgejo", origin, owner, name };
};

export const forge = (repo: ForgeRepo, token: string, fetch: Fetch): Forge => adapters[repo.kind].api(repo, token, fetch);

export const signed = (repo: ForgeRepo, secret: string, body: Buffer, headers: IncomingHttpHeaders): boolean =>
  adapters[repo.kind].signed(secret, body, headers);
