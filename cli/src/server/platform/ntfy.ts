import { err, ok, type Result } from "../../lib/result.ts";
import type { Alert, Notifier } from "./notify.ts";
import { typed } from "../../lib/typed.ts";

/**
 * Alerts as ntfy messages to one topic: one when an alert opens, one when it
 * is resolved. A push has no state of its own, so which alerts are open (and
 * their titles, for the resolving message) is kept in a state file per key.
 */
export type NtfyWorld = {
  readonly fetch: (url: string, init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body: string }) => Promise<{ readonly status: number }>;
  readonly token: () => Result<string, string>;
  readonly openAlert: (key: string) => string | undefined;
  readonly remember: (key: string, title: string | undefined) => void;
};

type NtfyMessage = {
  readonly topic: string;
  readonly title: string;
  readonly message: string;
  readonly priority: number;
  readonly tags: readonly string[];
};

export const ntfy = (url: string, topic: string, world: NtfyWorld) => {
  const publish = async (message: NtfyMessage) => {
    const token = world.token();
    if (!token.ok) return token;
    const response = await world
      .fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/json" },
        body: JSON.stringify(message),
      })
      .catch((error: unknown) => ({ status: 0, error: String(error) }) as const);
    return response.status >= 200 && response.status < 300 ? ok(undefined) : err(`ntfy POST ${url}: ${"error" in response ? response.error : String(response.status)}`);
  };

  const raise = async (alert: Alert) => {
    if (world.openAlert(alert.key) !== undefined) return ok(undefined);
    const sent = await publish({ topic, title: alert.title, message: alert.body, priority: 4, tags: ["rotating_light"] });
    if (sent.ok) world.remember(alert.key, alert.title);
    return sent;
  };

  const resolve = async (key: string, note: string) => {
    const title = world.openAlert(key);
    if (title === undefined) return ok(undefined);
    const sent = await publish({ topic, title: `Resolved: ${title}`, message: note, priority: 3, tags: ["white_check_mark"] });
    if (sent.ok) world.remember(key, undefined);
    return sent;
  };

  return typed<Notifier>({ raise, resolve });
};
