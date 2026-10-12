#!/usr/bin/env node
import { run } from "@optique/run";
import { createInterface } from "node:readline/promises";
import { absolutePath, kayraRoot, within } from "./brand.ts";
import { parser, type Command } from "./cli.ts";
import { doctor } from "./commands/doctor.ts";
import * as server from "./commands/server.ts";
import { status } from "./commands/status.ts";
import { serverNamed, type Fleet, type Server } from "./fleet.ts";
import { interpret, type Io } from "./interpret.ts";
import { findFleetRoot, loadFleet } from "./load.ts";
import { render, type Plan } from "./plan.ts";
import { flatMap, ok, type Result } from "./result.ts";

const here = absolutePath(process.cwd());
const engine = absolutePath(import.meta.dirname);
if (!here.ok || !engine.ok) throw new Error("node reported a relative path");
const kayra = kayraRoot(within(engine.value, "..", ".."));

type OnServer = Exclude<Command, { readonly name: "status" | "doctor" | "certs" | "app purge" }>;

const onServer = (on: server.Engine, target: Server, command: OnServer): Result<Plan, string> => {
  switch (command.name) {
    case "up":
      return server.up(on, target);
    case "provision":
      return server.provision(on, target);
    case "deploy":
      return server.deploy(on, target);
    case "setup":
      return server.setup(on, target);
    case "apps":
      return server.apps(on, target);
    case "hosts":
      return server.hosts(on, target);
    case "ssh":
      return server.ssh(target);
    case "down":
      return server.down(target);
    case "adopt":
      return server.adopt(on, target);
    case "backup test":
      return server.backupTest(on, target);
  }
};

const plan = (fleet: Fleet, command: Exclude<Command, { readonly name: "status" }>): Result<Plan, string> => {
  const on = { kayra, fleet: fleet.root };
  if (command.name === "doctor") return ok(doctor(fleet, kayra));
  if (command.name === "certs") return server.certsFor(on, command.domain, command.subdomains);
  if (command.name === "app purge")
    return flatMap(serverNamed(fleet, command.server), (target) => server.appPurge(on, target, command.app));
  return flatMap(serverNamed(fleet, command.server), (target) => onServer(on, target, command));
};

const io: Io = {
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
  ask: async (prompt) => {
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await terminal.question(prompt);
    terminal.close();
    return answer;
  },
};

const fail = (message: string): never => {
  console.error(`kayra: ${message}`);
  process.exit(1);
};

const fleet = flatMap(findFleetRoot(here.value), loadFleet);
if (!fleet.ok) fail(fleet.error);
else {
  const args = run(parser(fleet.value), { programName: "kayra", help: "both", completion: "both" });
  if (args.command.name === "status") {
    (await status(fleet.value)).forEach(io.out);
  } else {
    const steps = plan(fleet.value, args.command);
    if (!steps.ok) fail(steps.error);
    else if (args.dryRun) render(steps.value).forEach(io.out);
    // eslint-disable-next-line functional/immutable-data -- the exit status; process.exit() could cut piped output short
    else process.exitCode = (await interpret(steps.value, io)) ? 0 : 1;
  }
}
