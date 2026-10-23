import { err, ok, type Result } from "../../lib/result.ts";
import { field } from "../app.ts";
import type { Request } from "../runs/queue.ts";
import { typed } from "../../lib/typed.ts";

/**
 * Something wrong that lasts until a later run fixes it: the app's own ref
 * failed to deploy, or a platform job failed. One per key while it lasts.
 */
export type Alert = { readonly key: string; readonly title: string; readonly body: string };

/**
 * Where alerts go. `raise` opens an alert, or leaves the open one for its key
 * as it is; `resolve` ends the open one, if any, with a note. A notifier that
 * only sends messages (a push, a mail) sends one for each.
 */
export type Notifier = {
  readonly raise: (alert: Alert) => Promise<Result<void, string>>;
  readonly resolve: (key: string, note: string) => Promise<Result<void, string>>;
};

export const silent: Notifier = {
  raise: () => Promise.resolve(ok(undefined)),
  resolve: () => Promise.resolve(ok(undefined)),
};

/** The `notifier` setting, as the platform role passes it (NOTIFIER, JSON). */
export type NotifyConfig =
  | { readonly kind: "none" }
  | { readonly kind: "ntfy"; readonly url: string; readonly topic: string };

export const parseNotify = (raw: string | undefined) => {
  if (raw === undefined || raw.trim() === "") return ok<NotifyConfig>({ kind: "none" });
  try {
    const json: unknown = JSON.parse(raw);
    if (typeof json !== "object" || json === null) return err("notifier: not an object");
    const kind = field(json, "kind");
    const url = field(json, "url");
    const topic = field(json, "topic");
    if (kind !== "ntfy") return err(`notifier: unknown kind ${String(kind)}`);
    if (typeof url !== "string" || !/^https?:\/\/[^\s/]+\/?$/.test(url)) return err(`notifier: url ${String(url)}`);
    if (typeof topic !== "string" || !/^[\w-]{1,64}$/.test(topic)) return err(`notifier: topic ${String(topic)}`);
    return ok<NotifyConfig>({ kind, url: url.replace(/\/$/, ""), topic });
  } catch {
    return err("notifier: not JSON");
  }
};

export type RunEnd = {
  readonly server: string;
  readonly request: Request;
  readonly ok: boolean;
  readonly sha?: string;
  readonly page: string;
};

export type Decision =
  | { readonly kind: "raise"; readonly alert: Alert }
  | { readonly kind: "resolve"; readonly key: string; readonly note: string }
  | { readonly kind: "none" };

/**
 * What a finished run means for alerts. A deploy nobody watches that failed
 * (a push, the poll, a restore) raises; a deploy someone started by hand
 * (kayra app deploy | rollback) only resolves, since whoever started it is
 * watching. A platform job raises when it fails. Any success resolves.
 */
export const decide = (end: RunEnd) => {
  const { request, server } = end;
  const key = request.owner;
  const commit = end.sha === undefined ? "" : ` at ${end.sha.slice(0, 12)}`;
  if (end.ok) return typed<Decision>({ kind: "resolve", key, note: `Recovered: ${end.page}` });
  if (request.work.kind === "deploy") {
    if (request.work.why === "deploy" || request.work.why === "rollback") return typed<Decision>({ kind: "none" });
    return typed<Decision>({
      kind: "raise",
      alert: {
        key,
        title: `${server}: ${request.work.app} did not deploy${commit}`,
        body: `${request.work.app}'s ${request.work.ref} failed to build or deploy on ${server}${commit}, after a ${request.work.why}.\n\nThe run: ${end.page}\n\nIt stays open until a deploy of ${request.work.app} on ${server} succeeds.`,
      },
    });
  }
  return typed<Decision>({
    kind: "raise",
    alert: {
      key,
      title: `${server}: the ${request.work.job} job failed`,
      body: `The platform's ${request.work.job} job failed on ${server}.\n\nThe run: ${end.page}\n\nIt stays open until the job succeeds on ${server}.`,
    },
  });
};
