import { err, ok } from "../result.ts";
import type { Fetch, Forge, ForgeRepo } from "./forge.ts";

/** Commit statuses through a Forgejo's API (Gitea's statuses endpoint). */
export const forgejo = (repo: ForgeRepo, token: string, fetch: Fetch): Forge => ({
  postStatus: async (commit, status) => {
    const response = await fetch(`${repo.origin}/api/v1/repos/${repo.owner}/${repo.name}/statuses/${commit}`, {
      method: "POST",
      headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state: status.state, context: status.context, description: status.description, target_url: status.target }),
    }).catch(() => undefined);
    if (response === undefined) return err("no answer");
    return response.ok ? ok(undefined) : err(`HTTP ${String(response.status)}`);
  },
});
