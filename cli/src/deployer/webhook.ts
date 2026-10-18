import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { field } from "./app.ts";

/** A header's single value; undefined when it is missing or repeated. */
export const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
};

/** Whether `given` is the hex HMAC-SHA256 of the raw body under the platform's secret. */
export const hmacMatches = (secret: string, body: Buffer, given: string | undefined): boolean => {
  if (secret === "" || given === undefined || !/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
};

/** Whether `given` is the platform's secret itself, compared in constant time. */
export const secretMatches = (secret: string, given: string | undefined): boolean => {
  if (secret === "" || given === undefined) return false;
  const digest = (text: string): Buffer => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(secret), digest(given));
};

/** The ref a push event moved (`refs/heads/main`); undefined for any other event, e.g. GitHub's ping. All three forges send it as `ref`. */
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
