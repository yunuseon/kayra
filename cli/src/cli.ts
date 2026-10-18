import { command, constant, multiple, object, option, optional, or, type InferValue } from "@optique/core";
import { message, type Message } from "@optique/core/message";
import { argument } from "@optique/core/primitives";
import { choice, string } from "@optique/core/valueparser";
import { appNameParser, domainParser, serverNameParser, subdomainParser } from "./brand.ts";
import type { Fleet } from "./fleet.ts";

/** The arguments kayra takes; server names are the fleet's, so they complete and are checked while parsing. */
export const parser = (fleet: Fleet) => {
  const [first, ...rest] = fleet.servers.map((each) => each.name);
  // Outside a fleet there is no name to offer; main refuses every server command there.
  const server = argument(first === undefined ? serverNameParser : choice([first, ...rest], { metavar: "SERVER" }));
  // eslint-disable-next-line functional/prefer-immutable-types -- Optique's Message is readonly only at the top
  const onServer = <const N extends string>(name: N, brief: Message) =>
    command(name, object({ name: constant(name), server }), { brief });
  return object({
    dryRun: option("--dry-run", { description: message`Print the plan instead of running it.` }),
    command: or(
      // On one server
      or(
        onServer("up", message`Provision, set up everything, point /etc/hosts at it.`),
        onServer("provision", message`Create or update the machine (target home: build the image to import).`),
        onServer("deploy", message`Host setup and every app, no provisioning.`),
        onServer("setup", message`The host layer only: the playbook for the server's kind.`),
        onServer("plan", message`What provision and setup would change, changing nothing (OpenTofu plan, Ansible check mode).`),
        onServer("verify", message`Whether a platform server works as its users see it: logins, certificates, webhooks, apps, runs, alerts.`),
        onServer("apps", message`Make the server's apps match server.yml: register each, remove the rest (data kept).`),
        onServer("hosts", message`Point the domain at a multipass VM in /etc/hosts (sudo).`),
        command(
          "ssh",
          object({ name: constant("ssh"), server, remote: multiple(argument(string({ metavar: "COMMAND" }))) }),
          { brief: message`SSH into the server, or run a command there (after --).` },
        ),
        onServer("down", message`Destroy the machine.`),
        onServer("adopt", message`Once, for a server we did not create: add the deploy user as root.`),
        command("backup", command("test", object({ name: constant("backup test"), server })), {
          brief: message`Restore the latest backup to a scratch dir, check it, delete it.`,
        }),
        command(
          "app",
          or(
            command("check", object({ name: constant("app check"), dir: optional(argument(string({ metavar: "DIR" }))) }), {
              brief: message`In an app's repository: what the platform checks at deploy (app.yml, images, compose policy). No fleet needed.`,
            }),
            command("purge", object({ name: constant("app purge"), server, app: argument(appNameParser) }), {
              brief: message`Delete a removed app's volumes: its data, irreversibly.`,
            }),
            command("runs", object({ name: constant("app runs"), server, app: argument(appNameParser) }), {
              brief: message`The app's latest runs: id, result, commit, why.`,
            }),
            command(
              "logs",
              object({ name: constant("app logs"), server, app: argument(appNameParser), more: optional(argument(string({ metavar: "RUN" }))) }),
              { brief: message`A run's log, the newest unless named.` },
            ),
            command(
              "deploy",
              object({ name: constant("app deploy"), server, app: argument(appNameParser), more: optional(argument(string({ metavar: "REF" }))) }),
              { brief: message`Build and deploy a branch, tag or commit (default: the app's ref).` },
            ),
            command(
              "rollback",
              object({ name: constant("app rollback"), server, app: argument(appNameParser), more: optional(argument(string({ metavar: "SHA" }))) }),
              { brief: message`List earlier releases, or deploy one of them again.` },
            ),
          ),
          { brief: message`An app: check it before a push, or on a server its runs, logs, deploys, rollbacks, and purging its data.` },
        ),
        command(
          "job",
          object({
            name: constant("job"),
            server,
            job: argument(choice(["gc", "renovate"] as const, { metavar: "JOB" })),
            noPrs: option("--no-prs", { description: message`Renovate: log what would change, open no PRs.` }),
          }),
          { brief: message`Run a platform job now: the registry GC or Renovate.` },
        ),
      ),
      // On the whole fleet
      or(
        command(
          "status",
          object({
            name: constant("status"),
            json: option("--json", { description: message`The table as JSON on stdout, nothing on stderr.` }),
            offline: option("--offline", { description: message`Only what the fleet and OpenTofu's state say: reach no server.` }),
          }),
          { brief: message`Every server: where it is, whether SSH and its login answer.` },
        ),
        command(
          "certs",
          object({ name: constant("certs"), domain: argument(domainParser), subdomains: multiple(argument(subdomainParser)) }),
          { brief: message`mkcert certs for a domain and its subdomains (local dev, multipass).` },
        ),
        command(
          "validate",
          object({
            name: constant("validate"),
            server: optional(server),
            json: option("--json", { description: message`The findings as JSON on stdout, nothing on stderr.` }),
          }),
          { brief: message`Check the fleet beyond its schemas: secrets, apps against their contract, stacks, routes.` },
        ),
        command("doctor", object({ name: constant("doctor") }), {
          brief: message`Check that this Mac can run every command on every server.`,
        }),
      ),
    ),
  });
};

export type Args = InferValue<ReturnType<typeof parser>>;
export type Command = Args["command"];
