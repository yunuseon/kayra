import { z } from "zod";
import { appName } from "../brand.ts";
import type { Planned } from "../commands/index.ts";
import type { Fleet, Server } from "../fleet.ts";
import { err, flatMap, map, ok, type Result } from "../result.ts";
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

const appOf = (server: Server, name: string) =>
  flatMap(appName(name), (app) =>
    server.apps.some((each) => each.name === app) ? ok(app) : err(`'${name}' is not an app of ${server.name}`),
  );

/** The command as the CLI would have parsed it, checked against the fleet. */
export const toPlanned = (fleet: Fleet, input: CommandInput): Result<Planned, string> => {
  if (input.name === "doctor") return ok({ name: "doctor" });
  return flatMap(serverOf(fleet, input.server), (server): Result<Planned, string> => {
    switch (input.name) {
      case "app deploy":
        return map(appOf(server, input.app), (app) => ({ name: "app deploy", server: server.name, app, more: input.ref }));
      case "app rollback":
        return map(appOf(server, input.app), (app) => ({ name: "app rollback", server: server.name, app, more: input.sha }));
      case "app purge":
        return map(appOf(server, input.app), (app) => ({ name: "app purge", server: server.name, app }));
      case "job":
        return ok({ name: "job", server: server.name, job: input.job, noPrs: input.noPrs });
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
        return ok({ name: input.name, server: server.name });
    }
  });
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
