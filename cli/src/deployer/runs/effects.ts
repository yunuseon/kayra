import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { all, err, ok } from "../../lib/result.ts";
import type { App } from "../app.ts";
import type { Owner, RunId } from "../brand.ts";
import { builderPrepare, builderResolve } from "../build/client.ts";
import { appFiles, imagesFile, policy, routesFile } from "../build/compose.ts";
import { composeRuntime, type Execute } from "../../server/runtime/compose.ts";
import { forge } from "../forges/forge.ts";
import { forgeRepo } from "../../lib/forge-repo.ts";
import { spawnLines } from "../process.ts";
import { mounts, token, type Settings } from "../settings.ts";
import { releaseName } from "./records.ts";
import type { Effects, Env } from "./run.ts";
import { typed } from "../../lib/typed.ts";

const appSecrets = (app: App) => {
  const read = all(
    app.secrets.map((key) => {
      const path = join(mounts.apps, app.name, key);
      return existsSync(path) ? ok<readonly [string, string]>([key, readFileSync(path, "utf8")]) : err(`${app.name}: secret ${key} is missing; run kayra apps`);
    }),
  );
  return read.ok ? ok<Env>(Object.fromEntries(read.value)) : read;
};

/**
 * A GET through Traefik on platform-internal, so it needs neither the public
 * DNS nor a way back in from outside. Its certificate is verify's to judge, not
 * readiness's: on multipass it is mkcert's, which this container does not trust.
 */
const probe = async (url: string) => {
  const host = new URL(url).hostname;
  const exit = await spawnLines(
    ["curl", "-sk", "-o", "/dev/null", "-m", "10", "--connect-to", `${host}:443:traefik:443`, "-w", "%{http_code}", url],
    { cwd: "/", env: {}, capture: true, timeoutMs: 15_000 },
    () => undefined,
  );
  const status = Number.parseInt(exit.stdout, 10);
  return Number.isNaN(status) ? 0 : status;
};

/** A run's page, which its commit statuses link to. */
export const runPage = (s: Settings, who: Owner, id: RunId) => `https://deploy.${s.domain}/runs/${who}/${id}`;

export const commandExecution = (log: (line: string) => void) => typed<Execute>((argv, options) => spawnLines(argv, { ...options, timeoutMs: 20 * 60_000 }, log));

/** What one run does to this server; its files go into `scratch`, which the run removes when it ends. */
export const effects = (s: Settings, who: Owner, id: RunId, scratch: string, log: (line: string) => void) => typed<Effects>({
  log,
  resolve: (app, ref) => builderResolve(s.builder, app, ref),
  prepare: (app, commit) => builderPrepare(s.builder, app, commit, log),
  runtime: composeRuntime(commandExecution(log)),
  policy: (app, script, domain, bundle, cwd, resolved) => commandExecution(log)(policy(app, script, domain, bundle), { cwd, env: {}, stdin: resolved }),
  secrets: appSecrets,
  workdir: (bundle, images) => {
    writeFileSync(join(scratch, imagesFile), images);
    bundle.compose.forEach((file) => {
      const path = join(scratch, appFiles, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    });
    return Promise.resolve(scratch);
  },
  writeRoutes: (cwd, content) => {
    writeFileSync(join(cwd, routesFile), content);
    return Promise.resolve();
  },
  record: (app, commit, images) => {
    const dir = join(s.platformDir, "releases", app.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, releaseName(new Date(), commit)), images);
    return Promise.resolve();
  },
  status: async (app, commit, context, state, description) => {
    const repo = forgeRepo(app.repo);
    if (repo === undefined) {
      log(`(no commit status: ${app.repo} is on no forge kayra knows)`);
      return;
    }
    const posted = await forge(repo, token("GIT_TOKEN"), fetch).postStatus(commit, { context, state, description, target: runPage(s, who, id) });
    if (!posted.ok) log(`(commit status ${context} not posted: ${posted.error})`);
  },
  probe,
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
