import { z } from "zod";
import type { Invocation } from "../../core/operations/catalog.ts";
import { invocation } from "../../core/operations/run.ts";
import type { Fleet, Server } from "../../core/fleet.ts";
import { err, ok, type Result } from "../../result.ts";
import type { CommandInput, CommandName, ServerCommand, ServerFacts } from "./contract.ts";

const onServer = z.enum(["up", "provision", "deploy", "setup", "plan", "verify", "apps", "down", "adopt", "backup test"]);

/** What the browser may send; anything else is refused before the fleet is asked. */
export const commandInput = z.discriminatedUnion("name", [
  z.object({ name: onServer, server: z.string() }),
  z.object({ name: z.literal("app deploy"), server: z.string(), app: z.string(), ref: z.string().min(1).exactOptional() }),
  z.object({ name: z.literal("app rollback"), server: z.string(), app: z.string(), sha: z.string().regex(/^[0-9a-f]{7,40}$/) }),
  z.object({ name: z.literal("app purge"), server: z.string(), app: z.string() }),
  z.object({ name: z.literal("job"), server: z.string(), job: z.enum(["gc", "renovate"]), noPrs: z.boolean() }),
  z.object({ name: z.literal("doctor") }),
]) satisfies z.ZodType<CommandInput>;

/** The commands that read and change nothing: everything else asks first on a real server. */
const reading: readonly CommandName[] = ["plan", "verify", "doctor"];

export const changes = (input: CommandInput): boolean => !reading.includes(input.name);

const serverOf = (fleet: Fleet, name: string): Result<Server, string> => {
  const found = fleet.servers.find((each) => each.name === name);
  return found === undefined ? err(`no server '${name}' in this fleet`) : ok(found);
};

/** The server a command acts on, if one. */
export const targetOf = (fleet: Fleet, input: CommandInput): Result<Server | undefined, string> =>
  input.name === "doctor" ? ok(undefined) : serverOf(fleet, input.server);

/** The browser's command as the catalog's operation and input: the core checks it against the fleet. */
export const toInvocation = (input: CommandInput): Result<Invocation, string> => {
  switch (input.name) {
    case "doctor":
      return invocation("doctor", {});
    case "backup test":
      return invocation("backup.test", { server: input.server });
    case "app deploy":
      return invocation("app.deploy", { server: input.server, app: input.app, ...(input.ref === undefined ? {} : { ref: input.ref }) });
    case "app rollback":
      return invocation("app.rollback", { server: input.server, app: input.app, sha: input.sha });
    case "app purge":
      return invocation("app.purge", { server: input.server, app: input.app });
    case "job":
      return invocation("job", { server: input.server, job: input.job, noPrs: input.noPrs });
    case "up":
    case "provision":
    case "deploy":
    case "setup":
    case "plan":
    case "verify":
    case "apps":
    case "down":
    case "adopt":
      return invocation(input.name, { server: input.server });
  }
};

/** The command's words, as typed on the command line. */
export const words = (input: CommandInput): string => {
  const said = (...parts: readonly (string | undefined)[]): string => ["kayra", ...parts.filter((part) => part !== undefined)].join(" ");
  switch (input.name) {
    case "doctor":
      return said("doctor");
    case "app deploy":
      return said("app", "deploy", input.server, input.app, input.ref);
    case "app rollback":
      return said("app", "rollback", input.server, input.app, input.sha);
    case "app purge":
      return said("app", "purge", input.server, input.app);
    case "job":
      return said("job", input.server, input.job, input.noPrs ? "--no-prs" : undefined);
    case "up":
    case "provision":
    case "deploy":
    case "setup":
    case "plan":
    case "verify":
    case "apps":
    case "down":
    case "adopt":
    case "backup test":
      return said(input.name, input.server);
  }
};

/** What the browser offers for a server, the everyday ones first. */
export const offered = (server: Server): readonly (ServerCommand | "job")[] => {
  const creates = server.terraform || server.vm;
  return [
    ...(server.kind === "platform" ? (["deploy", "apps", "verify"] as const) : []),
    "setup",
    "plan",
    ...(server.target === "multipass" && server.kind === "platform" ? (["up"] as const) : []),
    ...(creates ? (["provision"] as const) : []),
    ...(server.backupDir === undefined ? [] : (["backup test"] as const)),
    ...(server.kind === "platform" ? (["job"] as const) : []),
    ...(server.target === "multipass" ? [] : (["adopt"] as const)),
    ...(server.terraform ? (["down"] as const) : []),
  ];
};

export const facts = (server: Server): ServerFacts => ({
  name: server.name,
  kind: server.kind,
  target: server.target,
  domain: server.domain,
  apps: server.apps.map((app) => app.name),
  commands: offered(server),
  needsTerminal: server.vault.kind === "ask",
});
