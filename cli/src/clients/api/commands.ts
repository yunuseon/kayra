import type { Server } from "../../core/fleet/model.ts";
import type { ServerCommand, ServerFacts } from "../wire/contract.gen.ts";
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
