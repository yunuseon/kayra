import type { ForgeRepo } from "../../lib/forge-repo.ts";
import { err, ok, type Result } from "../../lib/result.ts";
import { typed } from "../../lib/typed.ts";

/** A push webhook as a forge holds it: where it posts, and its id there. */
export type Hook = { readonly id: number; readonly url: string };

/** What a forge answered: its status, and its body as JSON where it had one. */
export type Answer = { readonly status: number; readonly json: unknown };

type Headers = Readonly<Record<string, string>>;

/** All the forges are asked: plain HTTP, so kayra needs no forge's tooling. */
export type Http = (url: string, init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string }) => Promise<Answer>;

/** One forge's REST API, as `app hook` asks it: with the platform's token, then the operator's. */
export type HookApi = {
  /** Whether the platform's token reads the repository, as the builder will. */
  readonly readable: (token: string) => Promise<Result<true, string>>;
  readonly hooks: (token: string) => Promise<Result<readonly Hook[], string>>;
  /** A push hook to `url`, signed with `secret` the way the deployer checks it: created, or the one with `id` set to it. */
  readonly save: (token: string, url: string, secret: string, id: number | undefined) => Promise<Result<Hook, string>>;
};

export const hookUrl = (domain: string, app: string) => `https://deploy.${domain}/hook/${app}`;

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Object.entries(value).find(([name]) => name === key)?.[1] : undefined;

const hookOf = (url: (value: unknown) => unknown) => (value: unknown) => {
  const id = field(value, "id");
  const to = url(value);
  return typeof id === "number" && typeof to === "string" ? typed<Hook>({ id, url: to }) : undefined;
};

const listed = (answer: Answer, of: (value: unknown) => Hook | undefined) =>
  Array.isArray(answer.json) ? Object.freeze(answer.json.flatMap((each) => { const hook = of(each); return hook === undefined ? Object.freeze([]) : Object.freeze([hook]); })) : typed<readonly Hook[]>([]);

const failed = (what: string, answer: Answer) =>
  err(`${what}: HTTP ${String(answer.status)}${answer.status === 401 || answer.status === 403 || answer.status === 404 ? " (does the token have admin rights on the repository?)" : ""}`);

/**
 * The three forges kayra knows, the same that the deployer verifies webhooks
 * for: GitHub's X-Hub-Signature-256, Forgejo's (or Gitea's) signature, GitLab's
 * secret token. Each hook is a JSON push hook to the deployer.
 */
export const hookApi = (repo: ForgeRepo, http: Http): HookApi => {
  const json = { "Content-Type": "application/json" };
  switch (repo.kind) {
    case "github": {
      const base = `https://api.github.com/repos/${repo.owner}/${repo.name}`;
      const auth = (token: string) => typed<Headers>({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" });
      const of = hookOf((value) => field(field(value, "config"), "url"));
      return {
        readable: async (token) => { const answer = await http(base, { method: "GET", headers: auth(token) }); return answer.status === 200 ? ok(true) : failed("the platform's git_token cannot read the repository", answer); },
        hooks: async (token) => { const answer = await http(`${base}/hooks`, { method: "GET", headers: auth(token) }); return answer.status === 200 ? ok(listed(answer, of)) : failed("listing the hooks", answer); },
        save: async (token, url, secret, id) => {
          const body = JSON.stringify({ active: true, events: ["push"], config: { url, content_type: "json", secret, insecure_ssl: "0" } });
          const answer = await http(id === undefined ? `${base}/hooks` : `${base}/hooks/${String(id)}`, { method: id === undefined ? "POST" : "PATCH", headers: { ...auth(token), ...json }, body });
          const hook = of(answer.json);
          return answer.status < 300 && hook !== undefined ? ok(hook) : failed("saving the hook", answer);
        },
      };
    }
    case "forgejo": {
      const base = `${repo.origin}/api/v1/repos/${repo.owner}/${repo.name}`;
      const auth = (token: string) => typed<Headers>({ Authorization: `token ${token}` });
      const of = hookOf((value) => field(field(value, "config"), "url"));
      return {
        readable: async (token) => { const answer = await http(base, { method: "GET", headers: auth(token) }); return answer.status === 200 ? ok(true) : failed("the platform's git_token cannot read the repository", answer); },
        hooks: async (token) => { const answer = await http(`${base}/hooks`, { method: "GET", headers: auth(token) }); return answer.status === 200 ? ok(listed(answer, of)) : failed("listing the hooks", answer); },
        save: async (token, url, secret, id) => {
          const config = { url, content_type: "json", secret };
          const body = JSON.stringify(id === undefined ? { type: "gitea", active: true, events: ["push"], config } : { active: true, events: ["push"], config });
          const answer = await http(id === undefined ? `${base}/hooks` : `${base}/hooks/${String(id)}`, { method: id === undefined ? "POST" : "PATCH", headers: { ...auth(token), ...json }, body });
          const hook = of(answer.json);
          return answer.status < 300 && hook !== undefined ? ok(hook) : failed("saving the hook", answer);
        },
      };
    }
    case "gitlab": {
      const base = `${repo.origin}/api/v4/projects/${encodeURIComponent(`${repo.owner}/${repo.name}`)}`;
      const auth = (token: string) => typed<Headers>({ Authorization: `Bearer ${token}` });
      const of = hookOf((value) => field(value, "url"));
      return {
        readable: async (token) => { const answer = await http(base, { method: "GET", headers: auth(token) }); return answer.status === 200 ? ok(true) : failed("the platform's git_token cannot read the repository", answer); },
        hooks: async (token) => { const answer = await http(`${base}/hooks`, { method: "GET", headers: auth(token) }); return answer.status === 200 ? ok(listed(answer, of)) : failed("listing the hooks", answer); },
        save: async (token, url, secret, id) => {
          const body = JSON.stringify({ url, token: secret, push_events: true, enable_ssl_verification: true });
          const answer = await http(id === undefined ? `${base}/hooks` : `${base}/hooks/${String(id)}`, { method: id === undefined ? "POST" : "PUT", headers: { ...auth(token), ...json }, body });
          const hook = of(answer.json);
          return answer.status < 300 && hook !== undefined ? ok(hook) : failed("saving the hook", answer);
        },
      };
    }
  }
};

/**
 * The repository readable by the platform's token, and exactly one push hook
 * to its deployer: an existing one is updated, so its secret is the platform's
 * now, never a second added.
 */
export const ensureHook = async (api: HookApi, url: string, tokens: { readonly platform: string; readonly operator: string }, secret: string) => {
  const readable = await api.readable(tokens.platform);
  if (!readable.ok) return readable;
  const existing = await api.hooks(tokens.operator);
  if (!existing.ok) return existing;
  const same = existing.value.filter((hook) => hook.url === url);
  if (same.length > 1) return err(`there are ${String(same.length)} hooks to ${url}; delete all but one`);
  const saved = await api.save(tokens.operator, url, secret, same[0]?.id);
  if (!saved.ok) return err(saved.error.replaceAll(secret, "…"));
  return ok(typed<readonly string[]>([
    "✓ the platform's token reads the repository",
    `✓ push hook ${same[0] === undefined ? "created" : "updated"}: ${url} (id ${String(saved.value.id)})`,
  ]));
};
