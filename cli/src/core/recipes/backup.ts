import type { Server } from "../fleet/model.ts";
import { run, type Plan } from "../plan/model.ts";
import { err, ok } from "../../lib/result.ts";
import { ansibleEnv, ansiblePath, inventory, reachable, withSecrets, type Engine } from "./steps.ts";
import { sshArgv } from "./ssh.ts";

/**
 * The restic-backup role's restore test: the latest backup, restored to a scratch dir and checked.
 * It runs on the server, detached; kayra follows its log over SSH. Stopping kayra stops only the
 * following, and running it again while a test runs follows that one instead of starting another.
 */
export const backupTest = (engine: Engine, server: Server) => {
  if (server.backupDir === undefined) return err(`${server.name} has no restic_backup.dir in its vars.yml`);
  if (server.inventory === undefined) return err(`no inventory for '${server.name}' — provision it first.`);
  return ok<Plan>([
    ...reachable(engine, server),
    withSecrets(run(
      "Start the restore test",
      ["ansible-playbook", "-i", inventory(server), ansiblePath(engine, "playbooks", "restore-test.yml"), "-e", `server_dir=${server.dir}`],
      ansibleEnv(engine, {}),
    ), server),
    { kind: "note", text: "Following the restore test. Ctrl-C stops following, not the test." },
    run(
      "Follow the restore test",
      sshArgv(server.inventory, ["-o", "StrictHostKeyChecking=accept-new"], ["sh", `${server.backupDir}/follow-restore-test.sh`]),
    ),
  ]);
};
