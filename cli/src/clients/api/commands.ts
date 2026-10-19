import type { Server } from "../../core/fleet/model.ts";
import type { Invocation } from "../../core/operations/catalog.ts";
import type { ServerCommand, ServerFacts } from "./contract.gen.ts";
import { typed } from "../../typed.ts";

export const offered = (server: Server) => typed<readonly (ServerCommand | "job")[]>([
  ...(server.kind === "platform" ? (["deploy", "apps", "verify"] as const) : []),
  "setup", "plan",
  ...(server.target === "multipass" && server.kind === "platform" ? (["up"] as const) : []),
  ...(server.hasTerraform || server.buildsVm ? (["provision"] as const) : []),
  ...(server.backupDir === undefined ? [] : (["backup.test"] as const)),
  ...(server.kind === "platform" ? (["job"] as const) : []),
  ...(server.target === "multipass" ? [] : (["adopt"] as const)),
  ...(server.hasTerraform ? (["down"] as const) : []),
]);

export const facts = (server: Server) => typed<ServerFacts>({
  name: server.name, kind: server.kind, target: server.target, domain: server.domain,
  apps: server.apps.map((app) => app.name), commands: offered(server),
});

export const words = (call: Invocation) => {
  const { input } = call;
  const scope = ["server" in input ? input.server : undefined, "app" in input ? input.app : undefined];
  const more = "command" in input ? ["--", ...input.command]
    : "job" in input ? [input.job, ...(input.noPrs ? ["--no-prs"] : [])]
    : "sha" in input ? [input.sha]
    : "ref" in input ? [input.ref]
    : "run" in input ? [input.run]
    : "dir" in input ? [input.dir]
    : "domain" in input ? [input.domain, ...input.subdomains] : [];
  const name = call.name === "ssh.exec" ? "ssh" : call.name === "app.releases" ? "app rollback" : call.name === "app.log" ? "app logs" : call.name.replaceAll(".", " ");
  return ["kayra", name, ...scope, ...more].filter((word) => word !== undefined).join(" ");
};
