import type { AppName, Domain, ServerName, Subdomain } from "../brand.ts";
import { serverNamed, type Fleet, type Server } from "../fleet.ts";
import type { Plan } from "../plan.ts";
import { flatMap, ok, type Result } from "../../result.ts";
import { doctor } from "./doctor.ts";
import * as server from "./server.ts";

/** A command on one server, as the core takes it from any client. */
type OnServer =
  | {
      readonly name: "up" | "provision" | "deploy" | "setup" | "plan" | "verify" | "apps" | "hosts" | "down" | "adopt" | "backup test";
      readonly server: ServerName;
    }
  | { readonly name: "ssh"; readonly server: ServerName; readonly remote: readonly string[] };
type Deployer =
  | { readonly name: "app runs"; readonly server: ServerName; readonly app: AppName }
  | { readonly name: "app logs" | "app deploy" | "app rollback"; readonly server: ServerName; readonly app: AppName; readonly more: string | undefined }
  | { readonly name: "job"; readonly server: ServerName; readonly job: "gc" | "renovate"; readonly noPrs: boolean };

/** The commands that run as a plan, as the core takes them: each client maps its own input onto these. */
export type Planned =
  | OnServer
  | Deployer
  | { readonly name: "app purge"; readonly server: ServerName; readonly app: AppName }
  | { readonly name: "certs"; readonly domain: Domain; readonly subdomains: readonly Subdomain[] }
  | { readonly name: "doctor" };

const appKinds = { "app runs": "runs", "app logs": "logs", "app deploy": "deploy", "app rollback": "rollback" } as const;

/** The deployer's commands: their answer is the output, nothing is drawn around it. */
export const isDeployer = (command: Planned): command is Deployer => command.name === "job" || command.name in appKinds;

const deployerCommand = (command: Deployer): server.DeployerCommand =>
  command.name === "job"
    ? { kind: "job", job: command.job, noPrs: command.noPrs }
    : { kind: appKinds[command.name], app: command.app, more: "more" in command ? command.more : undefined };

const onServer = (on: server.Engine, target: Server, command: OnServer): Result<Plan, string> => {
  switch (command.name) {
    case "up":
      return server.up(on, target);
    case "provision":
      return server.provision(on, target);
    case "deploy":
      return server.deploy(on, target);
    case "setup":
      return server.setup(on, target);
    case "plan":
      return server.preview(on, target);
    case "verify":
      return server.verify(on, target);
    case "apps":
      return server.apps(on, target);
    case "hosts":
      return server.hosts(on, target);
    case "ssh":
      return server.ssh(target, command.remote);
    case "down":
      return server.down(on, target);
    case "adopt":
      return server.adopt(on, target);
    case "backup test":
      return server.backupTest(on, target);
  }
};

/** A command as the plan that does it: what kayra runs, --dry-run prints and the web interface shows. */
export const planFor = (on: server.Engine, fleet: Fleet, command: Planned): Result<Plan, string> => {
  if (command.name === "doctor") return ok(doctor(fleet, on.kayra));
  if (command.name === "certs") return server.certsFor(on, command.domain, command.subdomains);
  if (command.name === "app purge")
    return flatMap(serverNamed(fleet, command.server), (target) => server.appPurge(on, target, command.app));
  if (isDeployer(command)) {
    const deployerArgs = deployerCommand(command);
    return flatMap(serverNamed(fleet, command.server), (target) => server.deployer(target, deployerArgs));
  }
  return flatMap(serverNamed(fleet, command.server), (target) => onServer(on, target, command));
};
