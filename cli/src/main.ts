#!/usr/bin/env node
import { run } from "@optique/run";
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { absolutePath, fleetRoot, kayraRoot, within } from "./core/brand.ts";
import { fromCommand } from "./clients/cli/invocation.ts";
import { parser, runOptions } from "./clients/cli/parser.ts";
import { verbose } from "./core/commands/server.ts";
import { opentofu, statusJson, statusView, type Look } from "./core/commands/status.ts";
import { overall, validateJson, validateView } from "./core/commands/validate.ts";
import type { Fleet, Server } from "./core/fleet.ts";
import { interpret, type Io } from "./core/interpret.ts";
import { findFleetRoot, loadFleet } from "./core/load.ts";
import { operation as describe } from "./core/operations/catalog.ts";
import { isPlan, planOf, query, serverOf, stream, type Context } from "./core/operations/run.ts";
import { systemBrowser } from "./clients/ui/opener.ts";
import { serve } from "./serve.ts";
import { network } from "./core/net.ts";
import { render, type Plan } from "./core/plan.ts";
import { flatMap, map, ok, type Result } from "./result.ts";
import { explain } from "./clients/cli/explain.ts";
import { bad, muted, strong } from "./core/present/line.ts";
import { silent, type Invocation } from "./core/present/progress.ts";
import { settle } from "./core/updates.ts";
import { framed } from "./clients/cli/framed.ts";
import { paint } from "./clients/cli/paint.ts";
import { screen, watch } from "./clients/cli/terminal.ts";
import { shortener, truncate } from "./core/present/text.ts";
import { z } from "zod";

const here = absolutePath(process.cwd());
const engine = absolutePath(import.meta.dirname);
if (!here.ok || !engine.ok) throw new Error("node reported a relative path");
const kayra = kayraRoot(within(engine.value, "..", ".."));
const version = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(kayra, "package.json"), "utf8"))).version;

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
// Outside a fleet only what works in an app's repository runs (app check).
const fleet: Result<Fleet, string> = found.ok ? found : ok({ root: fleetRoot(here.value), servers: [] });
if (!fleet.ok) fail(fleet.error);
else {
  const args = run(parser(fleet.value), runOptions(version));
  const short = shortener([
    [kayra, "<kayra>"],
    ...(found.ok ? [[fleet.value.root, "<fleet>"] as const] : []),
    [homedir(), "~"],
  ]);
  const context: Context = {
    engine: { kayra, fleet: fleet.value.root },
    fleet: fleet.value,
    version,
    here: here.value,
    read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
    network: network(2_000),
    tofu: opentofu,
  };
  if (args.command.name === "ui") {
    if (!found.ok) fail(found.error);
    // The browser side: web/dist in a checkout, cli/dist/browser in the package.
    const assets = [join(kayra, "web", "dist"), join(kayra, "cli", "dist", "browser")].find((dir) => existsSync(join(dir, "index.html")));
    const { port, noOpen } = args.command;
    const listening = await serve({ kayra, fleet: fleet.value, version, short, network: context.network }, assets, port);
    io.err([strong("kayra ui"), muted(` · ${fleet.value.servers.length.toString()} servers · kayra ${version} · Ctrl-C stops it`)]);
    io.out(listening.url);
    if (!noOpen) systemBrowser.open(listening.url);
    process.once("SIGINT", () => {
      void listening.close().then(() => process.exit(0));
    });
  } else {
    const { invocation: call, json } = fromCommand(args.command);
    const operation = describe(call.name);
    if (!found.ok && operation.scope !== "repo") fail(found.error);
    const target = serverOf(context, call);
    if (isPlan(call)) {
      const steps = map(planOf(context, call), (each) => (args.verbose ? verbose(each) : each));
      // An operation whose output is its answer (ssh, the deployer's) gets nothing drawn around it.
      if (!steps.ok) fail(steps.error);
      else if (args.dryRun) show(steps.value, invocation(target), short);
      else await execute(steps.value, invocation(target), operation.bare !== true);
    } else if (call.name === "status") {
      const { offline } = call.input;
      const { initial, updates } = stream(context, "status", call.input);
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
    } else if (call.name === "validate") {
      const reports = await query(context, "validate", call.input);
      if (!reports.ok) fail(reports.error);
      else {
        (json ? [JSON.stringify(validateJson(reports.value), null, 2)] : validateView(reports.value)).forEach(io.out);
        // eslint-disable-next-line functional/immutable-data -- the exit status; process.exit() could cut piped output short
        process.exitCode = reports.value.some((each) => overall(each.findings) === "problem") ? 1 : 0;
      }
    } else {
      // version: Optique answers `kayra version` and `--version` itself, before this.
      io.out(version);
    }
  }
}
