import { command, constant, group, map, merge, multiple, object, option, optional, or, withDefault, type InferValue } from "@optique/core";
import type { DocSection } from "@optique/core/doc";
import { lineBreak, message, text, url, type Message } from "@optique/core/message";
import { argument } from "@optique/core/primitives";
import type { Usage } from "@optique/core/usage";
import { choice, integer, string } from "@optique/core/valueparser";
import type { RunOptions } from "@optique/run";
import { appNameParser, domainParser, serverNameParser, subdomainParser } from "../../core/brand.ts";
import { operation, type OperationName } from "../../core/operations/catalog.ts";
import type { Fleet } from "../../core/fleet.ts";

/** A command's one line, as the catalog says it: the same words in every client. */
// eslint-disable-next-line functional/prefer-immutable-types -- Optique's Message is readonly only at the top
const summary = (name: OperationName): Message => message`${text(operation(name).summary)}`;

type Example = readonly [line: string, what: string];

/** Command lines, each with what it is for, aligned. Plain text: Optique folds an indent that stands alone before a command line. */
const examples = (indent: string, rows: readonly Example[]) => {
  const width = Math.max(...rows.map(([line]) => line.length));
  return rows.flatMap(([line, what], index) => [...(index === 0 ? [] : [lineBreak()]), text(`${indent}${line.padEnd(width)}  ${what}`)]);
};

const docs = message`Docs: ${url("https://yunuseon.github.io/kayra/")}`;

/** A command's examples; Optique shows a command's footer instead of the program's, so the docs follow. */
const footer = (...rows: readonly Example[]) => [
  ...message`Examples:`,
  lineBreak(),
  ...examples("  ", rows),
  lineBreak(),
  lineBreak(),
  ...docs,
];

const sections = ["On a server", "Apps on a server", "In an app's repository", "The whole fleet", "Options", "Help"];

/** Arguments (the untitled section) first, then the sections in the order above. */
const sectionOrder = (a: DocSection, b: DocSection): number => sections.indexOf(a.title ?? "") - sections.indexOf(b.title ?? "");

const usageLine: Usage = [
  { type: "argument", metavar: "COMMAND" },
  { type: "multiple", terms: [{ type: "argument", metavar: "ARG" }], min: 0 },
  { type: "optional", terms: [{ type: "option", names: ["--dry-run"] }] },
  { type: "optional", terms: [{ type: "option", names: ["-v", "--verbose"] }] },
];

/** How kayra presents itself: help in sections, examples, the docs; errors without the full usage above them. */
export const runOptions = (version: string) =>
  ({
    programName: "kayra",
    // `kayra help deploy` and `kayra version` work too; listed once, as options.
    help: { option: { names: ["-h", "--help"], group: "Help" }, command: { hidden: "doc" } },
    version: { value: version, option: { group: "Help" }, command: { hidden: "doc" } },
    // The option form's ARG cannot be hidden from the help page; completion scripts call the command.
    completion: { command: { group: "Help" } },
    brief: message`kayra ${text(version)}: a fleet's servers, from the machine to the apps on it.`,
    description: message`Run it anywhere inside a fleet (the directory holding servers/); app check also outside one. Server names are the fleet's and complete in the shell.`,
    examples: examples("", [
      ["kayra status", "every server, and whether it answers"],
      ["kayra up shop-test", "a server from nothing"],
      ["kayra plan shop-prod", "what this checkout would change on it"],
      ["kayra deploy shop-prod", "host setup and every app, then verify"],
      ["kayra deploy shop-prod --dry-run", "every step it would run, running none"],
      ["kayra setup shop-prod -v", "with Ansible's own output"],
      ["kayra app logs shop-prod shop", "the newest run's log"],
      ["kayra deploy --help", "a command's arguments and examples"],
    ]),
    footer: docs,
    usageLine,
    sectionOrder,
    termWidth: "auto",
    showChoices: true,
    aboveError: "none",
  }) satisfies RunOptions;

/** The arguments kayra takes; server names are the fleet's, so they complete and are checked while parsing. */
export const parser = (fleet: Fleet) => {
  const [first, ...rest] = fleet.servers.map((each) => each.name);
  // Outside a fleet there is no name to offer; main refuses every server command there.
  // Help adds the fleet's servers to its description (showChoices): kept short so they fit beside it.
  const server = argument(
    first === undefined ? serverNameParser : choice([first, ...rest], { metavar: "SERVER", suggest: "nearest" }),
    { description: message`A server` },
  );
  const app = argument(appNameParser, { description: message`An app in the server's server.yml.` });
  // eslint-disable-next-line functional/prefer-immutable-types -- Optique's Message is readonly only at the top
  const onServer = <const N extends string>(name: N, brief: Message, more: { readonly description?: Message; readonly footer?: Message } = {}) =>
    command(name, object({ name: constant(name), server }), { brief, ...more });
  return merge(
    group(
      "Options",
      object({
        dryRun: option("--dry-run", { description: message`Print the plan instead of running it.` }),
        verbose: option("-v", "--verbose", {
          description: message`Ansible's own output (with -v) instead of kayra's summary.`,
        }),
      }),
    ),
    map(
      or(
        group(
          "On a server",
          or(
            onServer("up", summary("up"), {
              description: message`Runs provision, then deploy (setup, apps, verify), then hosts: each part is a command of its own, and a failure names the one to run again.`,
              footer: footer(["kayra up shop-test", "a test server from nothing"]),
            }),
            onServer("provision", summary("provision")),
            onServer("deploy", summary("deploy"), {
              description: message`Runs setup, then apps; a platform server is verified at the end, so a deploy that leaves it broken fails. Hetzner and home servers change only from a clean main equal to its remote, with the kayra the fleet pins.`,
              footer: footer(
                ["kayra deploy shop-prod", "after a new kayra or a fleet change"],
                ["kayra deploy shop-prod --dry-run", "every step, its command and environment"],
                ["kayra deploy shop-prod -v", "with Ansible's own output"],
              ),
            }),
            onServer("setup", summary("setup"), {
              footer: footer(
                ["kayra setup shop-prod", "after a change to vars.yml or secrets.yml"],
                ["kayra setup shop-prod -v", "with Ansible's own output"],
              ),
            }),
            onServer("plan", summary("plan"), {
              description: message`OpenTofu's plan, then the playbook in check mode with diffs; files holding secrets only say that they would change. Works from any branch: it previews this checkout against the server.`,
              footer: footer(["kayra plan shop-prod", "what merging this branch would change on it"]),
            }),
            onServer("verify", summary("verify"), {
              description: message`Run by deploy and up at the end. The probes retry for VERIFY_WAIT seconds (150), for certificates still coming.`,
            }),
            onServer("apps", summary("apps"), {
              footer: footer(["kayra apps shop-prod", "after a change to apps/*.yml"]),
            }),
            onServer("hosts", summary("hosts")),
            command(
              "ssh",
              object({
                name: constant("ssh"),
                server,
                remote: multiple(argument(string({ metavar: "COMMAND" }), { description: message`A command to run there instead of a shell.` })),
              }),
              {
                brief: message`SSH into the server, or run a command there (after --).`,
                footer: footer(["kayra ssh shop-test", "a shell"], ["kayra ssh shop-test -- df -h /", "one command"]),
              },
            ),
            onServer("down", summary("down"), {
              description: message`OpenTofu destroy; on a Hetzner server only once its name is typed.`,
            }),
            onServer("adopt", summary("adopt")),
            command("backup", command("test", object({ name: constant("backup test"), server })), {
              brief: summary("backup.test"),
              footer: footer(["kayra backup test nas", "started on the server, followed over SSH"]),
            }),
          ),
        ),
        group(
          "Apps on a server",
          or(
            command(
              "app",
              or(
                group(
                  "In an app's repository",
                  command(
                    "check",
                    object({
                      name: constant("app check"),
                      dir: optional(argument(string({ metavar: "DIR" }), { description: message`The app's repository; the current directory by default.` })),
                    }),
                    {
                      brief: summary("app.check"),
                      footer: footer(["kayra app check", "in the app's repository, before a push"]),
                    },
                  ),
                ),
                group(
                  "On a server",
                  or(
                    command("purge", object({ name: constant("app purge"), server, app }), {
                      brief: summary("app.purge"),
                    }),
                    command("runs", object({ name: constant("app runs"), server, app }), {
                      brief: summary("app.runs"),
                    }),
                    command(
                      "logs",
                      object({
                        name: constant("app logs"),
                        server,
                        app,
                        more: optional(argument(string({ metavar: "RUN" }), { description: message`A run's id from app runs; the newest by default.` })),
                      }),
                      {
                        brief: summary("app.log"),
                        footer: footer(["kayra app logs shop-prod shop", "the newest run's log"]),
                      },
                    ),
                    command(
                      "deploy",
                      object({
                        name: constant("app deploy"),
                        server,
                        app,
                        more: optional(argument(string({ metavar: "REF" }), { description: message`A branch, tag or commit; the app's ref by default.` })),
                      }),
                      {
                        brief: summary("app.deploy"),
                        footer: footer(["kayra app deploy shop-prod shop v1.2.0", "a tag, now"]),
                      },
                    ),
                    command(
                      "rollback",
                      object({
                        name: constant("app rollback"),
                        server,
                        app,
                        more: optional(argument(string({ metavar: "SHA" }), { description: message`An earlier release's commit; 12 characters are enough.` })),
                      }),
                      {
                        brief: message`The releases, the live one marked, or deploy an earlier one again.`,
                        footer: footer(
                          ["kayra app rollback shop-prod shop", "what runs now, and before"],
                          ["kayra app rollback shop-prod shop 3f2a9c81d0be", "that release again"],
                        ),
                      },
                    ),
                  ),
                ),
              ),
              { brief: message`An app: check it before a push, or on a server its runs, logs, deploys, rollbacks, and purging its data.` },
            ),
            command(
              "job",
              object({
                name: constant("job"),
                server,
                job: argument(choice(["gc", "renovate"] as const, { metavar: "JOB", suggest: "nearest" }), {
                  description: message`Which job`,
                }),
                noPrs: option("--no-prs", { description: message`Renovate: log what would change, open no PRs.` }),
              }),
              {
                brief: summary("job"),
                footer: footer(["kayra job shop-prod renovate --no-prs", "what Renovate would change, no PRs"]),
              },
            ),
          ),
        ),
        group(
          "The whole fleet",
          or(
            command(
              "status",
              object({
                name: constant("status"),
                json: option("--json", { description: message`The table as JSON on stdout, nothing on stderr.` }),
                offline: option("--offline", { description: message`Only what the fleet and OpenTofu's state say: reach no server.` }),
              }),
              {
                brief: summary("status"),
                footer: footer(["kayra status", "every server, asked now"], ["kayra status --offline --json", "the fleet's own view, for a program"]),
              },
            ),
            command(
              "validate",
              object({
                name: constant("validate"),
                server: optional(server),
                json: option("--json", { description: message`The findings as JSON on stdout, nothing on stderr.` }),
              }),
              {
                brief: summary("validate"),
                footer: footer(["kayra validate", "every server"], ["kayra validate shop-prod", "one"]),
              },
            ),
            command("doctor", object({ name: constant("doctor") }), {
              brief: summary("doctor"),
            }),
            command(
              "serve",
              object({
                name: constant("serve"),
                ui: option("--ui", { description: message`Serve the browser interface (the default unless --api alone).` }),
                api: option("--api", { description: message`Allow local programs to use a bearer token; write .cache/serve.json.` }),
                port: withDefault(option("--port", integer({ min: 0, max: 65_535, metavar: "PORT" }), { description: message`Listen on this port (default: any free one).` }), 0),
                noOpen: option("--no-open", { description: message`Print the URL, open no browser.` }),
              }),
              {
                brief: message`The local browser interface and API: the fleet, its servers and apps, every command with its steps live.`,
                description: message`Listens on 127.0.0.1 only. The URL it prints carries this launch's token; nothing else gets in. Runs the same plans as the command line, with the same guards; a change to a real server asks for its name first.`,
                footer: footer(["kayra serve", "open it in the browser"], ["kayra serve --port 7700 --no-open", "for web/'s dev server"]),
              },
            ),
            command(
              "certs",
              object({
                name: constant("certs"),
                domain: argument(domainParser, { description: message`The domain the certificates are for.` }),
                subdomains: multiple(argument(subdomainParser, { description: message`Its subdomains, each with a certificate.` })),
              }),
              {
                brief: summary("certs"),
                footer: footer(["kayra certs shop.test www api", "into the fleet's .cache/certs"]),
              },
            ),
          ),
        ),
      ),
      (chosen): { readonly command: typeof chosen } => ({ command: chosen }),
    ),
  );
};

export type Args = InferValue<ReturnType<typeof parser>>;
export type Command = Args["command"];
