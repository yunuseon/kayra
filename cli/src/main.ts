#!/usr/bin/env node
import { run } from "@optique/run";
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { absolutePath, fleetRoot, kayraRoot, within } from "./brand.ts";
import { appCheck } from "./commands/app-check.ts";
import { parser, type Command } from "./cli.ts";
import { doctor } from "./commands/doctor.ts";
import * as server from "./commands/server.ts";
import { look, opentofu, statusJson, statusView, type Look } from "./commands/status.ts";
import { findings, overall, validateJson, validateView } from "./commands/validate.ts";
import { gather } from "./gather.ts";
import { serverNamed, type Fleet, type Server } from "./fleet.ts";
import { interpret, type Io } from "./interpret.ts";
import { findFleetRoot, loadFleet } from "./load.ts";
import { network } from "./net.ts";
import { render, type Plan } from "./plan.ts";
import { flatMap, ok, type Result } from "./result.ts";
import { explain } from "./ui/explain.ts";
import { bad, paint } from "./ui/line.ts";
import { framed, silent, type Invocation } from "./ui/progress.ts";
import { screen, settle, watch } from "./ui/terminal.ts";
import { truncate } from "./ui/text.ts";
import { z } from "zod";

const here = absolutePath(process.cwd());
const engine = absolutePath(import.meta.dirname);
if (!here.ok || !engine.ok) throw new Error("node reported a relative path");
const kayra = kayraRoot(within(engine.value, "..", ".."));
const version = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(kayra, "package.json"), "utf8"))).version;

type Deployer = Extract<Command, { readonly name: "app runs" | "app logs" | "app deploy" | "app rollback" | "job" }>;
type OnServer = Exclude<Command, Deployer | { readonly name: "status" | "validate" | "doctor" | "certs" | "app purge" | "app check" }>;

const appKinds = { "app runs": "runs", "app logs": "logs", "app deploy": "deploy", "app rollback": "rollback" } as const;

const isDeployer = (command: Command): command is Deployer => command.name === "job" || command.name in appKinds;

const deployerCommand = (command: Deployer): server.DeployerCommand =>
  command.name === "job"
    ? { kind: "job", job: command.job, noPrs: command.noPrs }
    : { kind: appKinds[command.name], app: command.app, more: "more" in command ? command.more : undefined };

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
    case "plan":
      return server.preview(on, target);
    case "verify":
      return server.verify(on, target);
    case "apps":
      return server.apps(on, target);
    case "hosts":
      return server.hosts(on, target);
    case "ssh":
      return server.ssh(target, command.remote);
    case "down":
      return server.down(on, target);
    case "adopt":
      return server.adopt(on, target);
    case "backup test":
      return server.backupTest(on, target);
  }
};

const plan = (fleet: Fleet, command: Exclude<Command, { readonly name: "status" | "validate" | "app check" }>): Result<Plan, string> => {
  const on = { kayra, fleet: fleet.root };
  if (command.name === "doctor") return ok(doctor(fleet, kayra));
  if (command.name === "certs") return server.certsFor(on, command.domain, command.subdomains);
  if (command.name === "app purge")
    return flatMap(serverNamed(fleet, command.server), (target) => server.appPurge(on, target, command.app));
  if (isDeployer(command)) {
    const deployerArgs = deployerCommand(command);
    return flatMap(serverNamed(fleet, command.server), (target) => server.deployer(target, deployerArgs));
  }
  return flatMap(serverNamed(fleet, command.server), (target) => onServer(on, target, command));
};

const screens = { out: screen(process.stdout, process.env), err: screen(process.stderr, process.env) };

const io: Io = {
  out: (text) => {
    console.log(paint(text, screens.out.colors, screens.out.links));
  },
  err: (text) => {
    console.error(paint(text, screens.err.colors, screens.err.links));
  },
  ask: async (prompt) => {
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    // Ctrl-C at the prompt, or no more input: no answer, so nothing happens.
    const answer = await new Promise<string>((resolve) => {
      terminal.once("SIGINT", () => {
        resolve("");
      });
      terminal.once("close", () => {
        resolve("");
      });
      void terminal.question(paint(prompt, screens.err.colors)).then(resolve, () => {
        resolve("");
      });
    });
    terminal.close();
    return answer;
  },
};

const fail = (message: string): never => {
  io.err(screens.err.live ? [bad("✗"), " ", message] : `kayra: ${message}`);
  process.exit(1);
};

/** The heading's facts: what the server is, and which kayra runs. */
const invocation = (target: Server | undefined): Invocation => ({
  command: ["kayra", ...process.argv.slice(2).filter((word) => word !== "--dry-run")].join(" "),
  ...(target === undefined ? {} : { server: target.name }),
  about: [...(target === undefined ? [] : [`${target.kind} on ${target.target}`, target.domain]), `kayra ${version}`],
});

/** Paths by the root they are under, the longest first: the engine may live inside the fleet. */
const shortener =
  (roots: readonly (readonly [string, string])[]) =>
  (text: string): string =>
    roots.toSorted(([a], [b]) => b.length - a.length).reduce((short, [path, name]) => short.replaceAll(path, name), text);

/** --dry-run: the plan as data, styled on a terminal, plain and copyable for a program. */
const show = (steps: Plan, about: Invocation, short: (text: string) => string): void => {
  (screens.out.live ? explain(about, steps, short, screens.out.columns) : render(steps)).forEach(io.out);
};

/** Runs a plan, framed on stderr unless its output is the point; the exit status says how it went. */
const execute = async (steps: Plan, about: Invocation, framing: boolean): Promise<void> => {
  const interrupt = new AbortController();
  // Ctrl-C reaches the step's program too; the plan stops once it gives up. A second one does not wait.
  process.once("SIGINT", () => {
    interrupt.abort();
    process.once("SIGINT", () => process.exit(130));
  });
  const progress = framing
    ? framed(screens.err, (raw) => process.stderr.write(raw), about)
    : silent;
  const passed = await interpret(steps, io, progress, () => interrupt.signal.aborted);
  // eslint-disable-next-line functional/immutable-data -- the exit status; process.exit() could cut piped output short
  process.exitCode = interrupt.signal.aborted ? 130 : passed ? 0 : 1;
};

const found = flatMap(findFleetRoot(here.value), loadFleet);
// Outside a fleet only `app check` runs: it works in an app's repository.
const fleet: Result<Fleet, string> = found.ok ? found : ok({ root: fleetRoot(here.value), servers: [] });
if (!fleet.ok) fail(fleet.error);
else {
  const args = run(parser(fleet.value), { programName: "kayra", help: "both", completion: "both", version: { value: version, command: true, option: true } });
  if (!found.ok && args.command.name !== "app check") fail(found.error);
  const short = shortener([
    [kayra, "<kayra>"],
    ...(found.ok ? [[fleet.value.root, "<fleet>"] as const] : []),
    [homedir(), "~"],
  ]);
  if (args.command.name === "app check") {
    const root = absolutePath(resolve(here.value, args.command.dir ?? "."));
    const manifestPath = root.ok ? join(root.value, "app.yml") : "";
    const steps = flatMap(root, (dir) => appCheck(kayra, dir, existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : undefined));
    if (!steps.ok) fail(steps.error);
    else if (args.dryRun) show(steps.value, invocation(undefined), short);
    else await execute(steps.value, invocation(undefined), true);
  } else if (args.command.name === "status") {
    const { json, offline } = args.command;
    const { initial, updates } = look(fleet.value, opentofu, offline ? undefined : network(2_000));
    // On a terminal the table is there at once, its cells filled in as the answers arrive; the report itself goes to stdout.
    const draw = (looks: readonly Look[], frame: string): readonly string[] =>
      statusView(looks, { frame, room: screens.err.columns - 1, offline }).map((line) =>
        paint(truncate(line, screens.err.columns - 1), screens.err.colors),
      );
    const looks =
      !json && screens.out.live && screens.err.live
        ? await watch((raw) => process.stderr.write(raw), initial, updates, draw)
        : await settle(initial, updates);
    (json
      ? [JSON.stringify(statusJson(looks), null, 2)]
      : statusView(looks, { frame: "", room: screens.out.live ? screens.out.columns : Infinity, offline })
    ).forEach(io.out);
  } else if (args.command.name === "validate") {
    const { server: chosen, json } = args.command;
    const servers = fleet.value.servers.filter((each) => chosen === undefined || each.name === chosen);
    const reports = await Promise.all(
      servers.map(async (each) => ({ server: each, findings: findings(await gather(fleet.value.root, each)) })),
    );
    (json ? [JSON.stringify(validateJson(reports), null, 2)] : validateView(reports)).forEach(io.out);
    // eslint-disable-next-line functional/immutable-data -- the exit status; process.exit() could cut piped output short
    process.exitCode = reports.some((each) => overall(each.findings) === "problem") ? 1 : 0;
  } else {
    const { command } = args;
    const steps = plan(fleet.value, command);
    const target = "server" in command ? fleet.value.servers.find((each) => each.name === command.server) : undefined;
    // ssh and the deployer's answers are the output itself: nothing around them.
    const framing = command.name !== "ssh" && !isDeployer(command);
    if (!steps.ok) fail(steps.error);
    else if (args.dryRun) show(steps.value, invocation(target), short);
    else await execute(steps.value, invocation(target), framing);
  }
}
