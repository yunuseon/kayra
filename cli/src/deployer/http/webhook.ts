import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { field } from "../app.ts";

/** A header's single value; undefined when it is missing or repeated. */
export const header = (headers: IncomingHttpHeaders, name: string) => {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
};

/** Whether `given` is the hex HMAC-SHA256 of the raw body under the platform's secret. */
export const hmacMatches = (secret: string, body: Buffer, given: string | undefined) => {
  if (secret === "" || given === undefined || !/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
};

/** Whether `given` is the platform's secret itself, compared in constant time. */
export const secretMatches = (secret: string, given: string | undefined) => {
  if (secret === "" || given === undefined) return false;
  // eslint-disable-next-line functional/prefer-immutable-types -- Node's Buffer: bytes, never changed here
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(secret), digest(given));
};

/** The ref a push event moved (`refs/heads/main`); undefined for any other event, e.g. GitHub's ping. All three forges send it as `ref`. */
export const pushedRef = (body: Buffer) => {
  try {
    const event: unknown = JSON.parse(body.toString("utf8"));
    if (typeof event !== "object" || event === null) return undefined;
    const ref = field(event, "ref");
    return typeof ref === "string" ? ref : undefined;
  } catch {
    return undefined;
  }
};
