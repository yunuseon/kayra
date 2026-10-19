import type { AppName } from "../fleet/brand.ts";
import type { Server } from "../fleet/model.ts";
import { partOf, type Plan, run, type RunStep } from "../plan/model.ts";
import { err, map, ok } from "../../lib/result.ts";
import { ansibleEnv, ansiblePath, collections, fromMain, inventory, vault, vaulted, type Engine } from "./steps.ts";
import { sshTo } from "./ssh.ts";
import { typed } from "../../lib/typed.ts";

/** Register every app in server.yml, then remove the rest (their data kept). */
export const apps = (engine: Engine, server: Server) => {
  const { env } = vault(server);
  const playbook = (title: string, name: string, ...extra: readonly string[]) =>
    vaulted(run(title, ["ansible-playbook", "-i", inventory(server), ansiblePath(engine, "playbooks", name), ...extra], ansibleEnv(engine, {})), server);
  return ok<Plan>(
    partOf("apps", [
      fromMain(engine, server),
      ...(server.kind === "platform"
        ? [
            ...server.apps.flatMap((app) => Object.freeze([
              collections(engine, env),
              playbook(
                `App ${app.name}`,
                "app.yml",
                "-e",
                `server=${server.name}`,
                "-e",
                `server_dir=${server.dir}`,
                "-e",
                `domain=${server.domain}`,
                "-e",
                `{"app": ${JSON.stringify(app.entry)}}`,
              ),
            ])),
            collections(engine, env),
            playbook(
              "Remove apps not in server.yml",
              "apps-prune.yml",
              "-e",
              `{"keep": ${JSON.stringify(server.apps.map((app) => app.name))}}`,
            ),
          ]
        : []),
    ]),
  );
};

/** A removed app's volumes: its data, irreversibly. */
export const appPurge = (engine: Engine, server: Server, app: AppName) =>
  ok<Plan>([
    fromMain(engine, server),
    run(
      `Delete ${app}'s volumes`,
      [
        "ansible",
        "servers",
        "-i",
        inventory(server),
        "--become",
        "-m",
        "ansible.builtin.command",
        "-a",
        `/opt/platform/bin/app-purge ${app}`,
      ],
      ansibleEnv(engine, {}),
    ),
  ]);

/** What `kayra app …` and `kayra job …` ask of a server: its deployer's ctl, over SSH. */
export type DeployerCommand =
  | { readonly kind: "runs" | "logs" | "deploy" | "rollback"; readonly app: AppName; readonly more: string | undefined }
  | { readonly kind: "job"; readonly job: "gc" | "renovate"; readonly noPrs: boolean };

/** What the deployer's ctl is asked, its title, and how its answer is shown: the lists as data kayra draws. */
type CtlCall = { readonly title: string; readonly args: readonly string[]; readonly stdout: RunStep["stdout"] };

const ctlCall = (server: Server, command: DeployerCommand) => {
  switch (command.kind) {
    case "job":
      return typed<CtlCall>({ title: `Job ${command.job}`, args: ["job", command.job, ...(command.noPrs ? ["--dry-run"] : [])], stdout: "show" });
    case "logs":
      return typed<CtlCall>({
        title: `Log of ${command.app}'s ${command.more === undefined ? "newest run" : `run ${command.more}`}`,
        args: ["log", command.app, ...(command.more === undefined ? [] : [command.more])],
        stdout: { view: "log", app: command.app, server: server.name },
      });
    case "runs":
      return typed<CtlCall>({ title: `Runs of ${command.app}`, args: ["runs", command.app, "--json"], stdout: { view: "runs", app: command.app, server: server.name } });
    case "deploy":
      return typed<CtlCall>({ title: `Deploy ${command.app} at ${command.more ?? "its ref"}`, args: ["deploy", command.app, ...(command.more === undefined ? [] : [command.more])], stdout: "show" });
    case "rollback":
      return typed<CtlCall>(command.more === undefined ? { title: `Releases of ${command.app}`, args: ["rollback", command.app, "--json"], stdout: { view: "releases", app: command.app, server: server.name } } : { title: `Roll ${command.app} back to ${command.more}`, args: ["rollback", command.app, command.more], stdout: "show" });
  }
};

/** Inside the deployer container, as the deploy user (in the docker group): nothing here needs root. */
export const deployer = (server: Server, command: DeployerCommand) => {
  if (server.kind !== "platform") return err(`'${server.name}' is a ${server.kind} server: only platform servers run apps.`);
  const call = ctlCall(server, command);
  return map(
    sshTo(server, ["cd", "/opt/platform", "&&", "docker", "compose", "exec", "-T", "deployer", "kayra-deployer", "ctl", ...call.args]),
    (argv) => typed<Plan>([{ ...run(call.title, argv), stdout: call.stdout }]),
  );
};
