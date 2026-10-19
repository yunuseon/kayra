import { err, ok } from "../../lib/result.ts";
import type { Adapter } from "./forge.ts";
import { header, hmacMatches } from "../http/webhook.ts";

/** A Forgejo's API (Gitea's statuses endpoint); webhooks signed `X-Forgejo-Signature: <hex>` (or Gitea's, or GitHub's, which it sends too). */
export const forgejo: Adapter = {
  api: (repo, token, fetch) => ({
    postStatus: async (commit, status) => {
      const response = await fetch(`${repo.origin}/api/v1/repos/${repo.owner}/${repo.name}/statuses/${commit}`, {
        method: "POST",
        headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state: status.state, context: status.context, description: status.description, target_url: status.target }),
      }).catch(() => undefined);
      if (response === undefined) return err("no answer");
      return response.ok ? ok(undefined) : err(`HTTP ${String(response.status)}`);
    },
  } as const),
  signed: (secret, body, headers) => {
    const hub = header(headers, "x-hub-signature-256");
    const own = header(headers, "x-forgejo-signature") ?? header(headers, "x-gitea-signature");
    return hmacMatches(secret, body, own ?? (hub?.startsWith("sha256=") === true ? hub.slice(7) : undefined));
  },
};
