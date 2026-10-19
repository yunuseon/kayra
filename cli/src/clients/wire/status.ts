import type { Look, Pending, Reach } from "../../core/status/model.ts";
import { authUrl, sshPort } from "../../core/status/look.ts";

export const ms = (reach: Reach | Pending) => ("ms" in reach ? reach.ms : null);

const error = (reach: Reach | Pending) => ("code" in reach ? reach.code : null);

/** `kayra status --json`: the shape cli.md documents. */
export const statusJson = (looks: readonly Look[]) => ({
  servers: looks.map(({ server, machine, ssh, https }) => ({
    name: server.name,
    kind: server.kind,
    target: server.target,
    domain: server.domain,
    apps: server.apps.map((app) => app.name),
    machine: {
      state: machine.kind,
      address: machine.kind === "found" ? (machine.address ?? null) : null,
      from: machine.kind === "found" ? machine.from : null,
      reason: machine.kind === "unreadable" ? machine.reason : null,
    },
    ssh: { port: Number(sshPort(server)), state: ssh.kind, ms: ms(ssh), error: error(ssh) },
    https:
      https === undefined
        ? null
        : {
            url: `${authUrl(server)}api/health`,
            state: https.kind,
            status: https.kind === "answered" ? https.status : null,
            ms: ms(https),
            error: error(https),
          },
  })),
} as const);
