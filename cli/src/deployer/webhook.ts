import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { field } from "./app.ts";

/**
 * Whether a webhook was signed with the platform's secret: GitHub's
 * `X-Hub-Signature-256: sha256=<hex>` (Forgejo sends it too), or Forgejo's own
 * `X-Forgejo-Signature: <hex>`. HMAC-SHA256 over the raw body.
 */
export const signed = (secret: string, body: Buffer, headers: IncomingHttpHeaders): boolean => {
  if (secret === "") return false;
  const hub = headers["x-hub-signature-256"];
  const forgejo = headers["x-forgejo-signature"] ?? headers["x-gitea-signature"];
  const given =
    typeof hub === "string" && hub.startsWith("sha256=") ? hub.slice(7) : typeof forgejo === "string" ? forgejo : undefined;
  if (given === undefined || !/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
};

/** The ref a push event moved (`refs/heads/main`); undefined for any other event, e.g. GitHub's ping. */
export const pushedRef = (body: Buffer): string | undefined => {
  try {
    const event: unknown = JSON.parse(body.toString("utf8"));
    if (typeof event !== "object" || event === null) return undefined;
    const ref = field(event, "ref");
    return typeof ref === "string" ? ref : undefined;
  } catch {
    return undefined;
  }
};
