import { err, ok } from "../result.ts";
import type { Fetch, Forge, ForgeRepo } from "./forge.ts";

/** Commit statuses through GitHub's REST API. */
export const github = (repo: ForgeRepo, token: string, fetch: Fetch): Forge => ({
  postStatus: async (commit, status) => {
    const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/statuses/${commit}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ state: status.state, context: status.context, description: status.description, target_url: status.target }),
    }).catch(() => undefined);
    if (response === undefined) return err("no answer");
    return response.ok ? ok(undefined) : err(`HTTP ${String(response.status)}`);
  },
});
