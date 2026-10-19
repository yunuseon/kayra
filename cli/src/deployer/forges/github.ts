import { err, ok } from "../../lib/result.ts";
import type { Adapter } from "./forge.ts";
import { header, hmacMatches } from "../http/webhook.ts";

/** GitHub's REST API; webhooks signed `X-Hub-Signature-256: sha256=<hex>`. */
export const github: Adapter = {
  api: (repo, token, fetch) => ({
    postStatus: async (commit, status) => {
      const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/statuses/${commit}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ state: status.state, context: status.context, description: status.description, target_url: status.target }),
      }).catch(() => undefined);
      if (response === undefined) return err("no answer");
      return response.ok ? ok(undefined) : err(`HTTP ${String(response.status)}`);
    },
  } as const),
  signed: (secret, body, headers) => {
    const hub = header(headers, "x-hub-signature-256");
    return hub?.startsWith("sha256=") === true && hmacMatches(secret, body, hub.slice(7));
  },
};
