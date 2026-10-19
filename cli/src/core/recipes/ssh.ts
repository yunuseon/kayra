import type { Inventory, Server } from "../fleet/model.ts";
import { run, type Argv, type Plan } from "../plan/model.ts";
import { err, map, ok } from "../../result.ts";
import { typed } from "../../typed.ts";

/** ssh to a server as its inventory says, its host key trusted as `hostKeys` say. */
export const sshArgv = (inventory: Inventory, hostKeys: readonly string[], remote: readonly string[]) => typed<Argv>([
  "ssh",
  "-p",
  inventory.port,
  "-i",
  inventory.key ?? "",
  ...hostKeys,
  `${inventory.user ?? ""}@${inventory.host ?? ""}`,
  ...remote,
]);

/** Rebuilt servers come back with new host keys: none is remembered. */
export const sshTo = (server: Server, remote: readonly string[]) =>
  server.inventory === undefined
    ? err(`no inventory for '${server.name}' — provision it first.`)
    : ok<Argv>(sshArgv(server.inventory, ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"], remote));

/** An interactive shell, or the remote command as ssh runs it (the remote shell reads it). */
export const ssh = (server: Server, remote: readonly string[]) =>
  map(sshTo(server, remote), (argv) => typed<Plan>([remote.length === 0 ? { ...run("SSH", argv), kind: "session" } : run("SSH", argv)]));
