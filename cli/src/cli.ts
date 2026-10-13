import { command, constant, multiple, object, option, optional, or, type InferValue } from "@optique/core";
import { message, type Message } from "@optique/core/message";
import { argument } from "@optique/core/primitives";
import { choice } from "@optique/core/valueparser";
import { appNameParser, domainParser, subdomainParser } from "./brand.ts";
import type { Fleet } from "./fleet.ts";

/** The arguments kayra takes; server names are the fleet's, so they complete and are checked while parsing. */
export const parser = (fleet: Fleet) => {
  const server = argument(choice(fleet.servers.map((each) => each.name), { metavar: "SERVER" }));
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
        onServer("apps", message`Make the server's apps match server.yml: register each, remove the rest (data kept).`),
        onServer("hosts", message`Point the domain at a multipass VM in /etc/hosts (sudo).`),
        onServer("ssh", message`SSH into the server.`),
        onServer("down", message`Destroy the machine.`),
        onServer("adopt", message`Once, for a server we did not create: add the deploy user as root.`),
        command("backup", command("test", object({ name: constant("backup test"), server })), {
          brief: message`Restore the latest backup to a scratch dir, check it, delete it.`,
        }),
        command(
          "app",
          command("purge", object({ name: constant("app purge"), server, app: argument(appNameParser) })),
          { brief: message`Delete a removed app's volumes: its data, irreversibly.` },
        ),
      ),
      // On the whole fleet
      or(
        command("status", object({ name: constant("status") }), {
          brief: message`Every server and whether a machine exists for it.`,
        }),
        command(
          "certs",
          object({ name: constant("certs"), domain: argument(domainParser), subdomains: multiple(argument(subdomainParser)) }),
          { brief: message`mkcert certs for a domain and its subdomains (local dev, multipass).` },
        ),
        command("validate", object({ name: constant("validate"), server: optional(server) }), {
          brief: message`Check the fleet beyond its schemas: secrets, apps against their contract, stacks, routes.`,
        }),
        command("doctor", object({ name: constant("doctor") }), {
          brief: message`Check that this Mac can run every command on every server.`,
        }),
      ),
    ),
  });
};

export type Args = InferValue<ReturnType<typeof parser>>;
export type Command = Args["command"];
