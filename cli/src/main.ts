#!/usr/bin/env node
import { run } from "@optique/run";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { absolutePath, fleetRoot, kayraRoot, kayraVersion, within } from "./core/fleet/brand.ts";
import { questions } from "./clients/cli/questions.ts";
import { fromCommand } from "./clients/cli/invocation.ts";
import { parser, runOptions } from "./clients/cli/parser.ts";
import { verbose } from "./core/recipes/steps.ts";
import { opentofu } from "./core/adapters/opentofu.ts";
import { statusJson } from "./clients/wire/status.ts";
import { statusView } from "./clients/cli/status.ts";
import type { Look } from "./core/status/model.ts";
import { overall } from "./core/validation/findings.ts";
import { validateJson } from "./clients/wire/validate.ts";
import { validateView } from "./clients/cli/validate.ts";
import type { Fleet, Server } from "./core/fleet/model.ts";
import { interpret } from "./core/interpreter/loop.ts";
import type { Io } from "./core/interpreter/io.ts";
import { findFleetRoot, loadFleet } from "./core/fleet/load.ts";
import { operation as describe } from "./core/operations/catalog.ts";
import { contextFor, hasPlan, planOf, query, serverOf, stream } from "./core/operations/dispatch.ts";
import { systemBrowser } from "./clients/ui/opener.ts";
import { serve } from "./serve.ts";
import { network } from "./core/adapters/network.ts";
import { render } from "./core/plan/describe.ts";
import type { Plan } from "./core/plan/model.ts";
import { err, flatMap, map, ok } from "./lib/result.ts";
import { explain } from "./clients/cli/explain.ts";
import { draw } from "./clients/cli/views.ts";
import { bad, muted, strong } from "./core/text/spans.ts";
import { silent } from "./core/interpreter/progress.ts";
import { heading, type Heading } from "./core/interpreter/events.ts";
import { settle } from "./core/status/updates.ts";
import { framed } from "./clients/cli/framed.ts";
import { paint } from "./clients/cli/paint.ts";
import { screen, watch } from "./clients/cli/terminal.ts";
import { shortener, truncate } from "./clients/cli/text.ts";
import { z } from "zod";

const here = absolutePath(process.cwd());
const engine = absolutePath(import.meta.dirname);
if (!here.ok || !engine.ok) throw new Error("node reported a relative path");
const kayra = kayraRoot(within(engine.value, "..", ".."));
const declared = kayraVersion(z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(kayra, "package.json"), "utf8"))).version);
if (!declared.ok) throw new Error(`kayra's package.json: version ${declared.error}`);
const version = declared.value;

const screens = { out: screen(process.stdout, process.env), err: screen(process.stderr, process.env) };

const input = questions((text) => paint(text, screens.err.colors));

const io: Io = {
  out: (text) => {
    console.log(paint(text, screens.out.colors, screens.out.links));
  },
  err: (text) => {
    console.error(paint(text, screens.err.colors, screens.err.links));
  },
  ask: (question) => input.ask(question),
  draw: (answer, said) => draw(answer, said, Date.now()),
};

const fail = (message: string) => {
  io.err(screens.err.live ? [bad("✗"), " ", message] : `kayra: ${message}`);
  process.exit(1);
};

/** The heading: the command as typed, what it runs on, which kayra. */
const invocation = (target: Server | undefined) =>
  heading(["kayra", ...process.argv.slice(2).filter((word) => word !== "--dry-run")].join(" "), target, version);

/** --dry-run: the plan as data, styled on a terminal, plain and copyable for a program. */
const show = (steps: Plan, about: Heading, short: (text: string) => string) => {
  (screens.out.live ? explain(about, steps, short, screens.out.columns) : render(steps)).forEach(io.out);
};

/** Runs a plan, framed on stderr unless its output is the point; the exit status says how it went. */
const execute = async (steps: Plan, about: Heading, framing: boolean) => {
  const interrupt = new AbortController();
  // Ctrl-C reaches the step's program too; the plan stops once it gives up. A second one does not wait.
  process.once("SIGINT", () => {
    interrupt.abort();
    process.once("SIGINT", () => process.exit(130));
  });
  const progress = framing
    ? framed(screens.err, (raw) => process.stderr.write(raw), about)
    : silent;
  const passed = await interpret(steps, { ...io, signal: interrupt.signal }, progress, () => interrupt.signal.aborted).finally(input.close);
  // eslint-disable-next-line functional/immutable-data -- the exit status; process.exit() could cut piped output short
  process.exitCode = interrupt.signal.aborted ? 130 : passed ? 0 : 1;
};

const found = flatMap(findFleetRoot(here.value), loadFleet);
// Outside a fleet only what works in an app's repository runs (app check).
const fleet: Fleet = found.ok ? found.value : { root: fleetRoot(here.value), servers: [] };
const args = run(parser(fleet), runOptions(version));
const short = shortener([
  [kayra, "<kayra>"],
  ...(found.ok ? [[fleet.root, "<fleet>"] as const] : []),
  [homedir(), "~"],
]);
const context = contextFor({ kayra, fleet: fleet, version, here: here.value, network: network(2_000), tofu: opentofu });
if (args.command.name === "serve") {
  if (!found.ok) fail(found.error);
  // The browser side: web/dist in a checkout, cli/dist/browser in the package.
  const assets = [join(kayra, "web", "dist"), join(kayra, "cli", "dist", "browser")].find((dir) => existsSync(join(dir, "index.html")));
  const { port, noOpen } = args.command;
  const clients = { ui: args.command.ui || !args.command.api, api: args.command.api };
  // The port taken, or the discovery file in the way: kayra says why instead of a stack trace.
  const started = await serve({ kayra, fleet, version, short, network: context.network }, assets, port, clients).then(ok, (error: unknown) =>
    err(error instanceof Error ? error.message : String(error)),
  );
  if (!started.ok) fail(`could not start: ${started.error}`);
  else {
    const listening = started.value;
    io.err([strong("kayra serve"), muted(` · ${fleet.servers.length.toString()} servers · kayra ${version} · Ctrl-C stops it`)]);
    io.out(listening.url);
    if (listening.discovery !== undefined) io.err([muted(`API credentials: ${listening.discovery}`)]);
    if (clients.ui && !noOpen) systemBrowser.open(listening.url);
    const stop = () => { void listening.close().then(() => process.exit(0)); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
} else {
  const { invocation: call, json } = fromCommand(args.command);
  const operation = describe(call.name);
  if (!found.ok && operation.scope !== "repo") fail(found.error);
  const target = serverOf(context, call);
  if (hasPlan(call)) {
    const steps = map(planOf(context, call), (each) => (args.verbose ? verbose(each) : each));
    // An operation whose output is its answer (ssh, the deployer's) gets nothing drawn around it.
    if (!steps.ok) fail(steps.error);
    else if (args.dryRun) show(steps.value, invocation(target), short);
    else await execute(steps.value, invocation(target), operation.bare !== true);
  } else if (call.name === "status") {
    const { offline } = call.input;
    const { initial, updates } = stream(context, "status", call.input);
    // On a terminal the table is there at once, its cells filled in as the answers arrive; the report itself goes to stdout.
    const draw = (looks: readonly Look[], frame: string) =>
      Object.freeze(statusView(looks, { frame, room: screens.err.columns - 1, offline }).map((line) =>
        paint(truncate(line, screens.err.columns - 1), screens.err.colors),
      ));
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
