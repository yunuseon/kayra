import { timingSafeEqual } from "node:crypto";

/** What admission reads of a request. */
export type Asked = {
  readonly method: string;
  readonly path: string;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly cookie: string | undefined;
};

export type Admission = { readonly admitted: true } | { readonly admitted: false; readonly status: 401 | 403; readonly why: string };

/** Cookies are shared by every port of a host: the name carries the port, so another local server's cookie is not ours. */
export const cookieName = (port: number): string => `kayra_ui_${String(port)}`;

const origins = (port: number): readonly string[] => [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`];

const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const cookieValue = (header: string | undefined, name: string): string | undefined =>
  header
    ?.split(";")
    .map((pair) => pair.trim().split("="))
    .find(([key]) => key === name)?.[1];

const refuse = (status: 401 | 403, why: string): Admission => ({ admitted: false, status, why });

/**
 * Whether a request may reach kayra ui. Every request: a Host of this
 * listener (a page elsewhere cannot rebind a name to it). A write: an Origin
 * of this listener (no other site's form posts here). The API: the launch's
 * token, as its cookie.
 */
export const admit = (asked: Asked, port: number, token: string): Admission => {
  if (asked.host === undefined || !origins(port).includes(asked.host)) return refuse(403, "not this listener's host");
  const writes = asked.method !== "GET" && asked.method !== "HEAD";
  if (writes && !origins(port).some((each) => asked.origin === `http://${each}`)) return refuse(403, "not this listener's origin");
  if (!asked.path.startsWith("/api/")) return { admitted: true };
  const presented = cookieValue(asked.cookie, cookieName(port));
  return presented !== undefined && same(presented, token) ? { admitted: true } : refuse(401, "no token: open the URL kayra ui printed");
};

/** The token the opened URL carries, if it is this launch's. */
export const tokenIn = (query: URLSearchParams, token: string): boolean => {
  const given = query.get("token");
  return given !== null && same(given, token);
};
