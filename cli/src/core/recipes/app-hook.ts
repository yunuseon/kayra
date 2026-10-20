import type { Server } from "../fleet/model.ts";
import { within, type AppName, type FleetRoot } from "../fleet/brand.ts";
import { type Plan, run } from "../plan/model.ts";
import { err, ok } from "../../lib/result.ts";
import { onPath, vaulted, type Engine } from "./steps.ts";

/**
 * The app's repository wired to its deployer: the platform's token can read
 * it, and one push hook posts to deploy.<domain>/hook/<app> with the platform's
 * secret (kayra-app-hook.js; GitHub through the operator's gh login).
 */
export const appHook = (engine: Engine, root: FleetRoot, server: Server, app: AppName) => {
  if (server.kind !== "platform") return err(`'${server.name}' is a ${server.kind} server: only platform servers run apps.`);
  if (!server.apps.some((each) => each.name === app)) return err(`${app} is not in ${server.name}'s server.yml`);
  return ok<Plan>([
    onPath("gh is installed", "gh", "brew install gh, then gh auth login", "stop"),
    vaulted(run(`Hook ${app}'s repository to ${server.name}`, [process.execPath, within(engine.kayra, "bin", "kayra-app-hook.js"), JSON.stringify({ root, server: server.name, app })]), server),
  ]);
};
