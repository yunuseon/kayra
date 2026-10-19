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

/** What follows the server and the app on the command line, by operation. */
const extra = (call: Invocation) => {
  switch (call.name) {
    case "ssh.exec":
      return ["--", ...call.input.command];
    case "job":
      return [call.input.job, ...(call.input.noPrs ? ["--no-prs"] : [])];
    case "app.rollback":
      return [call.input.sha];
    case "app.deploy":
      return call.input.ref === undefined ? [] : [call.input.ref];
    case "app.log":
      return call.input.run === undefined ? [] : [call.input.run];
    case "app.check":
      return [call.input.dir];
    case "certs":
      return [call.input.domain, ...call.input.subdomains];
    case "up":
    case "provision":
    case "deploy":
    case "setup":
    case "plan":
    case "verify":
    case "apps":
    case "hosts":
    case "ssh":
    case "down":
    case "adopt":
    case "backup.test":
    case "app.purge":
    case "app.runs":
    case "app.releases":
    case "status":
    case "validate":
    case "doctor":
    case "version":
      return [];
  }
};

/** How the command line spells an operation where its words are not its name's. */
const spelled: Partial<Readonly<Record<Invocation["name"], string>>> = { "ssh.exec": "ssh", "app.releases": "app rollback", "app.log": "app logs" };

/** The command's words, as typed on the command line. */
export const words = (call: Invocation) => {
  const { input } = call;
  const scope = ["server" in input ? input.server : undefined, "app" in input ? input.app : undefined];
  const name = spelled[call.name] ?? call.name.replaceAll(".", " ");
  return ["kayra", name, ...scope, ...extra(call)].filter((word) => word !== undefined).join(" ");
};
