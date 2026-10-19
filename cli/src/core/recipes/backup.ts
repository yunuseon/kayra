import { within } from "../fleet/brand.ts";
import type { Server } from "../fleet/model.ts";
import { run, type Plan } from "../plan/model.ts";
import { err, ok, type Result } from "../../result.ts";
import { ansibleEnv, inventory, reachable, vaulted, type Engine } from "./steps.ts";
import { sshArgv } from "./ssh.ts";

/**
 * The restic-backup role's restore test: the latest backup, restored to a scratch dir and checked.
 * It runs on the server, detached; kayra follows its log over SSH. Stopping kayra stops only the
 * following, and running it again while a test runs follows that one instead of starting another.
 */
export const backupTest = (engine: Engine, server: Server): Result<Plan, string> => {
  if (server.backupDir === undefined) return err(`${server.name} has no restic_backup.dir in its vars.yml`);
  if (server.inventory === undefined) return err(`no inventory for '${server.name}' — provision it first.`);
  return ok([
    ...reachable(engine, server),
    vaulted(run(
      "Start the restore test",
      [
        "ansible",
        "servers",
        "-i",
        inventory(server),
        "--become",
        "-e",
        `@${within(server.dir, "secrets.yml")}`,
        "-m",
        "ansible.builtin.command",
        "-a",
        `docker compose -f ${server.backupDir}/docker-compose.yml exec -d -T backup /etc/backup/restore-test.sh`,
      ],
      ansibleEnv(engine, {}),
    ), server),
    { kind: "note", text: "Following the restore test. Ctrl-C stops following, not the test." },
    run(
      "Follow the restore test",
      sshArgv(server.inventory, ["-o", "StrictHostKeyChecking=accept-new"], ["sh", `${server.backupDir}/follow-restore-test.sh`]),
    ),
  ]);
};
