import type { Server } from "../fleet/model.ts";
import { within, type AppName, type FleetRoot } from "../fleet/brand.ts";
import { type Plan, run } from "../plan/model.ts";
import { err, flatMap, ok, type Result } from "../../lib/result.ts";
import { vaulted, type Engine } from "./steps.ts";

/** Whether a server takes push webhooks: its vars.yml's `webhooks` (default true), and a forge able to reach it. */
export const takesWebhooks = (server: Server): Result<true, string> => {
  if (server.kind !== "platform") return err(`'${server.name}' is a ${server.kind} server: only platform servers run apps.`);
  if (server.vars["webhooks"] === false) return err(`${server.name} takes no webhooks (webhooks: false in its vars.yml): pushes deploy by deploy_poll`);
  if (server.target === "multipass") return err(`no forge can reach ${server.name}, a multipass VM: deploy there with kayra app deploy`);
  return ok(true);
};

/**
 * The app's repository wired to its deployer: the platform's token can read
 * it, and one push hook posts to deploy.<domain>/hook/<app> with the platform's
 * secret (kayra-app-hook.js, over the forge's REST API as the operator).
 */
export const appHook = (engine: Engine, root: FleetRoot, server: Server, app: AppName) =>
  flatMap(takesWebhooks(server), () => {
    if (!server.apps.some((each) => each.name === app)) return err(`${app} is not in ${server.name}'s server.yml`);
    return ok<Plan>([
      vaulted(run(`Hook ${app}'s repository to ${server.name}`, [process.execPath, within(engine.kayra, "bin", "kayra-app-hook.js"), JSON.stringify({ root, server: server.name, app })]), server),
    ]);
  });
