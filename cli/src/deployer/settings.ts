import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../lib/result.ts";
import { parseCron, type Cron } from "./cron.ts";
import { parseNotify, silent, type Notifier, type NotifyConfig } from "./forges/notify.ts";
import { ntfy } from "./forges/ntfy.ts";
import type { Env } from "./runs/run.ts";
import { typed } from "../lib/typed.ts";

/** What the deployer runs with, from its environment and the secrets mounted into it. */
export type Settings = {
  readonly platformDir: string;
  readonly appsDir: string;
  readonly builder: string;
  readonly domain: string;
  readonly policyScript: string;
  readonly gcScript: string;
  readonly renovateImage: string;
  readonly renovate: Cron | undefined;
  readonly gc: Cron;
  readonly poll: Cron;
  readonly env: Env;
  /** The server's name in the fleet, for alerts that may come from several. */
  readonly server: string;
  readonly notifier: Notifier;
};

/** Mounted into the deployer only: the platform's tokens, each app's secrets, the notifier's key. */
export const mounts = { platform: "/run/platform-secrets", apps: "/run/app-secrets", deployer: "/run/deployer-secrets" } as const;

/** A platform token, read on every use: a new one needs no restart. */
export const token = (name: string) => {
  const path = join(mounts.platform, name);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
};

const must = <T>(result: Result<T, string>) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

/** The configured notifier; its open alerts are kept in <platformDir>/alerts/<key>, each holding its title. */
const notifierFor = (config: NotifyConfig, platformDir: string) => {
  if (config.kind === "none") return silent;
  const alerts = join(platformDir, "alerts");
  const tokenFile = join(mounts.deployer, "NOTIFIER_NTFY_TOKEN");
  return ntfy(config.url, config.topic, {
    fetch: async (url, init) => Object.freeze({ status: (await fetch(url, init)).status }),
    token: () => (existsSync(tokenFile) ? ok(readFileSync(tokenFile, "utf8").trim()) : err(`${tokenFile} is missing: notifier_ntfy_token in secrets.yml`)),
    openAlert: (key) => {
      const path = join(alerts, key);
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    },
    remember: (key, title) => {
      mkdirSync(alerts, { recursive: true });
      if (title === undefined) rmSync(join(alerts, key), { force: true });
      else writeFileSync(join(alerts, key), title);
    },
  });
};

export const settings = (env: NodeJS.ProcessEnv) => {
  const scripts = env["PLATFORM_SCRIPTS"] ?? "/opt/kayra/scripts/platform";
  const platformDir = env["PLATFORM_DIR"] ?? "/opt/platform";
  const strings = Object.fromEntries(Object.entries(env).flatMap(([key, value]) => typed<readonly (readonly [string, string])[]>(value === undefined ? [] : [[key, value]])));
  return typed<Settings>({
    platformDir,
    appsDir: env["APPS_DIR"] ?? "/opt/apps",
    builder: env["BUILDER_URL"] ?? "http://builder:8081",
    domain: env["DOMAIN"] ?? "localhost",
    policyScript: join(scripts, "compose-policy.sh"),
    gcScript: join(scripts, "registry-gc.sh"),
    renovateImage: env["RENOVATE_IMAGE"] ?? "",
    renovate: env["PLATFORM_RENOVATE"] === "true" ? must(parseCron(env["RENOVATE_SCHEDULE"] ?? "0 4 * * 1")) : undefined,
    gc: must(parseCron("0 3 * * *")),
    poll: must(parseCron(env["DEPLOY_POLL"] ?? "17 * * * *")),
    env: strings,
    server: env["SERVER"] ?? env["DOMAIN"] ?? "this server",
    notifier: notifierFor(must(parseNotify(env["NOTIFIER"])), platformDir),
  });
};

/** Where runs/ is: <owner>/<id>/{meta.json,log}. */
export const runsDir = (s: Settings) => join(s.platformDir, "runs");
