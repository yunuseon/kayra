import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok } from "../../lib/result.ts";
import { silent, type NotifyConfig } from "./notify.ts";
import { ntfy } from "./ntfy.ts";

/** The configured notifier; its open alerts are kept in <platformDir>/alerts/<key>, each holding its title. */
export const notifierFor = (config: NotifyConfig, platformDir: string, deployerSecrets: string) => {
  if (config.kind === "none") return silent;
  const alerts = join(platformDir, "alerts");
  const tokenFile = join(deployerSecrets, "NOTIFIER_NTFY_TOKEN");
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
