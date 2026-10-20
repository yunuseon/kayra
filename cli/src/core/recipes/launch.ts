import type { App, Server } from "../fleet/model.ts";
import { within, type AbsolutePath, type AppName, type FleetRoot } from "../fleet/brand.ts";
import { appEntrySchema } from "../fleet/settings.ts";
import { type Plan, run } from "../plan/model.ts";
import { err, flatMap, map, ok, type Result } from "../../lib/result.ts";
import { apps, deployer } from "./apps.ts";
import { appHook, takesWebhooks } from "./app-hook.ts";
import { forgeRepo } from "../../lib/forge-repo.ts";
import { vaulted, type Engine } from "./steps.ts";
import { typed } from "../../lib/typed.ts";

export type Launch = {
  readonly app: AppName;
  readonly repo: string | undefined;
  readonly ref: string | undefined;
  readonly path: string | undefined;
  /** The app's local checkout, for its app.yml before the fleet has cloned it. */
  readonly dir: AbsolutePath | undefined;
};

/** The server.yml entry the launch registers, or the one already there; a different one given is refused, never overwritten. */
const entryOf = (server: Server, launch: Launch): Result<Readonly<Record<string, unknown>>, string> => {
  const registered = server.apps.find((app) => app.name === launch.app);
  if (registered === undefined) {
    if (launch.repo === undefined) return err(`${launch.app} is not in ${server.name}'s server.yml yet: give its repository with --repo https://…`);
    return ok({ name: launch.app, repo: launch.repo, ...(launch.ref === undefined ? {} : { ref: launch.ref }), ...(launch.path === undefined ? {} : { path: launch.path }) });
  }
  const differs = (["repo", "ref", "path"] as const).filter((key) => launch[key] !== undefined && launch[key] !== (registered.entry[key] ?? (key === "path" ? "." : key === "ref" ? "main" : undefined)));
  return differs.length === 0
    ? ok(registered.entry)
    : err(`${server.name}'s server.yml registers ${launch.app} with another ${differs.join(", ")}: change it there, not through launch`);
};

/**
 * An app from its repository to a URL that answers, in one plan that may be
 * run again until it ends: register it in server.yml and check that every value
 * it declares is set (kayra-app-launch.js), apply the apps (kayra apps, the new
 * entry included), deploy it and follow the run (its readiness included), then,
 * where the server takes webhooks and the repository is on a forge kayra knows,
 * its push hook.
 * On a server changed only from main, the server.yml change stops the apply
 * at its guard until it is merged: the launch says so, and a rerun goes on.
 */
export const launch = (engine: Engine, root: FleetRoot, server: Server, wanted: Launch) => {
  if (server.kind !== "platform") return err(`'${server.name}' is a ${server.kind} server: only platform servers run apps.`);
  return flatMap(entryOf(server, wanted), (raw) => {
    const parsed = appEntrySchema.safeParse(raw);
    if (!parsed.success) return err(`not an app entry: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
    const app = typed<App>({ name: parsed.data.name, repo: parsed.data.repo, path: parsed.data.path, entry: raw });
    const registered = server.apps.some((each) => each.name === app.name);
    const withApp = registered ? server : { ...server, apps: [...server.apps, app] };
    const prepare = vaulted(
      run(`Register ${app.name} and check its values`, [
        process.execPath,
        within(engine.kayra, "bin", "kayra-app-launch.js"),
        JSON.stringify({ root, server: server.name, entry: raw, ...(wanted.dir === undefined ? {} : { dir: wanted.dir }) }),
      ]),
      server,
    );
    const hook = takesWebhooks(server).ok && forgeRepo(app.repo) !== undefined ? appHook(engine, root, withApp, app.name) : ok<Plan>([]);
    return flatMap(apps(engine, withApp), (applied) =>
      flatMap(deployer(server, { kind: "deploy", app: app.name, more: undefined }), (deploy) =>
        map(hook, (hooked) => typed<Plan>([prepare, ...applied, ...deploy, ...hooked])),
      ),
    );
  });
};
