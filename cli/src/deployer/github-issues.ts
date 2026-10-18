import { createSign } from "node:crypto";
import { err, ok, type Result } from "../result.ts";
import { field } from "./app.ts";
import type { Alert, Notifier } from "./notify.ts";

/**
 * Alerts as GitHub issues in one repository, opened by a GitHub App: GitHub
 * notifies no one about their own actions, so a personal token's issue would
 * reach nobody. One issue per alert key while it lasts; the next resolve
 * comments and closes it. Which issue is open for a key is kept in a state
 * file, like the backup check's.
 */
export type GithubIssueWorld = {
  readonly fetch: (url: string, init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string }) => Promise<{ readonly status: number; readonly json: unknown }>;
  readonly privateKey: () => Result<string, string>;
  readonly now: () => number;
  readonly openIssue: (key: string) => number | undefined;
  readonly remember: (key: string, issue: number | undefined) => void;
};

const base64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

/** The app's own token: a JWT signed with its private key, valid nine minutes. */
export const appJwt = (appId: string, privateKey: string, nowSeconds: number): string => {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
};

const api = "https://api.github.com";
const headers = (token: string): Readonly<Record<string, string>> => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
});

export const githubIssues = (repository: string, appId: string, world: GithubIssueWorld): Notifier => {
  const call = async (token: string, method: string, path: string, body?: object): Promise<Result<unknown, string>> => {
    const response = await world
      .fetch(`${api}${path}`, { method, headers: headers(token), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      .catch((error: unknown) => ({ status: 0, json: String(error) }));
    return response.status >= 200 && response.status < 300 ? ok(response.json) : err(`GitHub ${method} ${path}: ${String(response.status)}`);
  };

  /** The installation's token for the repository, through the app's JWT. */
  const token = async (): Promise<Result<string, string>> => {
    const key = world.privateKey();
    if (!key.ok) return key;
    const jwt = appJwt(appId, key.value, Math.floor(world.now() / 1000));
    const installation = await call(jwt, "GET", `/repos/${repository}/installation`);
    const id = installation.ok && typeof installation.value === "object" && installation.value !== null ? field(installation.value, "id") : undefined;
    if (typeof id !== "number") return err(installation.ok ? "GitHub: the app is not installed on the repository" : installation.error);
    const access = await call(jwt, "POST", `/app/installations/${String(id)}/access_tokens`);
    const value = access.ok && typeof access.value === "object" && access.value !== null ? field(access.value, "token") : undefined;
    return typeof value === "string" ? ok(value) : err(access.ok ? "GitHub: no installation token" : access.error);
  };

  const raise = async (alert: Alert): Promise<Result<void, string>> => {
    if (world.openIssue(alert.key) !== undefined) return ok(undefined);
    const minted = await token();
    if (!minted.ok) return minted;
    const created = await call(minted.value, "POST", `/repos/${repository}/issues`, { title: alert.title, body: alert.body });
    if (!created.ok) return created;
    const number = typeof created.value === "object" && created.value !== null ? field(created.value, "number") : undefined;
    if (typeof number !== "number") return err("GitHub: the new issue has no number");
    world.remember(alert.key, number);
    return ok(undefined);
  };

  const resolve = async (key: string, note: string): Promise<Result<void, string>> => {
    const issue = world.openIssue(key);
    if (issue === undefined) return ok(undefined);
    const minted = await token();
    if (!minted.ok) return minted;
    const commented = await call(minted.value, "POST", `/repos/${repository}/issues/${String(issue)}/comments`, { body: note });
    if (!commented.ok) return commented;
    const closed = await call(minted.value, "PATCH", `/repos/${repository}/issues/${String(issue)}`, { state: "closed", state_reason: "completed" });
    if (!closed.ok) return closed;
    world.remember(key, undefined);
    return ok(undefined);
  };

  return { raise, resolve };
};
