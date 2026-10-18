import { err, ok } from "../result.ts";
import type { Adapter, State } from "./forge.ts";
import { header, secretMatches } from "./webhook.ts";

/** GitLab knows no "failure" or "error", only "failed". */
const states: Readonly<Record<State, string>> = { pending: "pending", success: "success", failure: "failed", error: "failed" };

/**
 * GitLab's REST API (v4), the project addressed by its URL-encoded path; the
 * context is a status's name. Webhooks carry the secret itself as
 * `X-Gitlab-Token`: GitLab signs nothing.
 */
export const gitlab: Adapter = {
  api: (repo, token, fetch) => ({
    postStatus: async (commit, status) => {
      const project = encodeURIComponent(`${repo.owner}/${repo.name}`);
      const response = await fetch(`${repo.origin}/api/v4/projects/${project}/statuses/${commit}`, {
        method: "POST",
        headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json" },
        body: JSON.stringify({ state: states[status.state], name: status.context, description: status.description, target_url: status.target }),
      }).catch(() => undefined);
      if (response === undefined) return err("no answer");
      return response.ok ? ok(undefined) : err(`HTTP ${String(response.status)}`);
    },
  }),
  signed: (secret, _body, headers) => secretMatches(secret, header(headers, "x-gitlab-token")),
};
