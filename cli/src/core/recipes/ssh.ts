import type { Server } from "../fleet/model.ts";
import { run, type Argv, type Plan } from "../plan/model.ts";
import { err, map, ok, type Result } from "../../result.ts";

export const sshTo = (server: Server, remote: readonly string[]): Result<Argv, string> =>
  server.inventory === undefined
    ? err(`no inventory for '${server.name}' — provision it first.`)
    : ok([
        "ssh",
        "-p",
        server.inventory.port,
        "-i",
        server.inventory.key,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        `${server.inventory.user}@${server.inventory.host}`,
        ...remote,
      ]);

/** An interactive shell, or the remote command as ssh runs it (the remote shell reads it). */
export const ssh = (server: Server, remote: readonly string[]): Result<Plan, string> =>
  map(sshTo(server, remote), (argv) => [remote.length === 0 ? { ...run("SSH", argv), kind: "session" } : run("SSH", argv)]);
